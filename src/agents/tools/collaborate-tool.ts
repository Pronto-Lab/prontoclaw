import { Type } from "@sinclair/typebox";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { loadConfig } from "../../config/config.js";
import { trackOutboundMention } from "../../discord/a2a-retry/index.js";
import { checkCollaborateRateLimit } from "../../discord/loop-guard.js";
import { getBotUserIdForAgent, resolveAgentBotUserId } from "../../discord/monitor/sibling-bots.js";
import { registerThreadParticipants } from "../../discord/monitor/thread-participants.js";
import { sendMessageDiscord, createThreadDiscord } from "../../discord/send.js";
import { logVerbose } from "../../globals.js";
import {
  ChannelRouter,
  type RouteContext,
  type RouteResult,
} from "../../infra/events/sinks/channel-router.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// ── Types ───────────────────────────────────────────────────────────

export interface CollaborateOutput {
  success: boolean;
  threadId?: string;
  threadName?: string;
  channelId?: string;
  messageId?: string;
  note?: string;
  error?: string;
}

// ── Schema ──────────────────────────────────────────────────────────

const CollaborateToolSchema = Type.Object({
  targetAgent: Type.String({ description: "대상 에이전트 ID (예: eden, ruda, seum, dajim)" }),
  message: Type.String({ description: "전달할 메시지" }),
  threadId: Type.Optional(Type.String({ description: "기존 스레드에 이어쓰기 (선택)" })),
  channelId: Type.Optional(
    Type.String({
      description:
        "새 스레드를 만들 채널 ID (선택, 미지정 시 LLM Router가 자동으로 적절한 채널 선택)",
    }),
  ),
  threadName: Type.Optional(Type.String({ description: "새 스레드 이름 (선택)" })),
});

// ── Channel Router Singleton ────────────────────────────────────────

let cachedRouter: ChannelRouter | null = null;
let routerConfigChecked = false;

interface SinkOptions {
  guildId?: string;
  defaultChannelId?: string;
  routerAccountId?: string;
  routerModel?: string;
}

function getOrCreateRouter(): ChannelRouter | null {
  if (cachedRouter) {
    return cachedRouter;
  }
  if (routerConfigChecked) {
    return null; // Already checked, no config available
  }
  routerConfigChecked = true;

  try {
    const cfg = loadConfig();
    const sinks = cfg.gateway?.conversationSinks;
    if (!Array.isArray(sinks) || sinks.length === 0) {
      logVerbose("collaborate: no conversationSinks configured, router unavailable");
      return null;
    }

    // Find the discord-conversation sink
    const discordSink = sinks.find(
      (s: Record<string, unknown>) =>
        s.id === "discord-conversation" || s.type === "discord-conversation",
    );
    if (!discordSink) {
      logVerbose("collaborate: no discord-conversation sink found");
      return null;
    }

    const opts = (discordSink.options ?? discordSink) as SinkOptions;
    const guildId = opts.guildId;
    const defaultChannelId = opts.defaultChannelId;

    if (!guildId || !defaultChannelId) {
      logVerbose("collaborate: sink missing guildId or defaultChannelId");
      return null;
    }

    cachedRouter = new ChannelRouter({
      guildId,
      defaultChannelId,
      accountId: opts.routerAccountId ?? "ruda",
      routerModel: opts.routerModel,
    });

    logVerbose("collaborate: ChannelRouter initialized from conversationSinks config");
    return cachedRouter;
  } catch (err) {
    logVerbose("collaborate: failed to initialize ChannelRouter: " + String(err));
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

/**
 * Resolve target bot's Discord user ID with config-based fallback.
 * Stage 1: direct reverse map lookup via resolveAgentBotUserId
 * Stage 2: iterate discord account bindings from config
 */
function resolveTargetBotId(targetAgent: string): string | undefined {
  // Stage 1: direct lookup (covers dual-registered agentId + accountId)
  const direct = resolveAgentBotUserId(targetAgent);
  if (direct) {
    return direct;
  }

  // Stage 2: load config and build bindings for fallback
  try {
    const cfg = loadConfig();
    const discordAccounts = (cfg.channels as Record<string, unknown>)?.discord;
    if (!discordAccounts || typeof discordAccounts !== "object") {
      return undefined;
    }

    const accounts = (discordAccounts as Record<string, unknown>).accounts;
    if (!accounts || typeof accounts !== "object") {
      return undefined;
    }

    for (const accountId of Object.keys(accounts)) {
      try {
        const route = resolveAgentRoute({ cfg, channel: "discord", accountId });
        if (route.agentId === targetAgent) {
          const botId = getBotUserIdForAgent(accountId);
          if (botId) {
            return botId;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Config load failure — non-critical
  }

  return undefined;
}

/**
 * Register thread participants + track outbound mention.
 * Shared by both "existing thread" and "new thread" code paths.
 */
function registerAndTrack(params: {
  threadId: string;
  messageId: string;
  fromBotUserId: string | undefined;
  targetBotId: string;
  fromAgentId: string;
  targetAgent: string;
  message: string;
}): void {
  // Register both sender and target as thread participants
  const participantIds = [params.fromBotUserId, params.targetBotId].filter(Boolean) as string[];
  if (participantIds.length > 0) {
    try {
      registerThreadParticipants(params.threadId, participantIds);
      logVerbose("collaborate: registered thread participants for thread " + params.threadId);
    } catch (regErr) {
      logVerbose("collaborate: failed to register thread participants: " + String(regErr));
    }
  }

  // Track outbound mention for a2a-retry
  trackOutboundMention({
    messageId: params.messageId,
    threadId: params.threadId,
    fromAgentId: params.fromAgentId,
    targetAgentId: params.targetAgent,
    targetBotId: params.targetBotId,
    originalText: truncateText(params.message, 500),
  }).catch((trackErr) => {
    logVerbose("collaborate: failed to track outbound mention: " + String(trackErr));
  });
}

/**
 * Use ChannelRouter to find the best channel/thread for this collaboration.
 * Returns null if router is unavailable or fails.
 */
async function routeViaLLM(params: {
  fromAgentId: string;
  targetAgent: string;
  message: string;
}): Promise<RouteResult | null> {
  const router = getOrCreateRouter();
  if (!router) {
    return null;
  }

  try {
    const cfg = loadConfig();
    const fromIdentity = resolveAgentIdentity(cfg, params.fromAgentId);
    const toIdentity = resolveAgentIdentity(cfg, params.targetAgent);

    const routeCtx: RouteContext = {
      message: truncateText(params.message, 500),
      fromAgent: params.fromAgentId,
      toAgent: params.targetAgent,
      fromAgentName: fromIdentity?.name ?? params.fromAgentId,
      toAgentName: toIdentity?.name ?? params.targetAgent,
      conversationId: `collaborate_${[params.fromAgentId, params.targetAgent].toSorted().join("-")}`,
    };

    logVerbose("collaborate: routing via ChannelRouter");
    const result = await router.route(routeCtx);
    logVerbose(
      `collaborate: router result — channel:${result.channelId} thread:${result.threadId ?? "new"} name:"${result.threadName}"`,
    );
    return result;
  } catch (err) {
    logVerbose("collaborate: ChannelRouter failed, falling back: " + String(err));
    return null;
  }
}

// ── Main Handler ────────────────────────────────────────────────────

export async function handleCollaborate(params: {
  targetAgent: string;
  message: string;
  threadId?: string;
  channelId?: string;
  threadName?: string;
  fromAgentId?: string;
  fromBotUserId?: string;
  accountId?: string;
  currentChannelId?: string;
}): Promise<CollaborateOutput> {
  const { targetAgent, message, threadId, fromAgentId } = params;

  logVerbose("collaborate: resolving bot id for agent " + targetAgent);

  const targetBotId = resolveTargetBotId(targetAgent);
  if (!targetBotId) {
    return {
      success: false,
      error: `'${targetAgent}'에 대한 Discord 봇 매핑을 찾을 수 없습니다. config에서 agentId '${targetAgent}'의 Discord accountId/봇 바인딩을 확인하세요.`,
    };
  }

  const resolvedFromAgent = fromAgentId ?? "unknown";

  // ── Loop Guard: per-pair collaborate rate limit ──
  if (resolvedFromAgent !== "unknown") {
    const rateLimitResult = checkCollaborateRateLimit(resolvedFromAgent, targetAgent);
    if (rateLimitResult.blocked) {
      const resetMin = Math.ceil((rateLimitResult.resetInMs ?? 0) / 60_000);
      logVerbose(
        `collaborate: rate limit exceeded for ${resolvedFromAgent} <-> ${targetAgent} (${rateLimitResult.currentCount}/${rateLimitResult.maxAllowed} in ${rateLimitResult.windowMs / 1000}s)`,
      );
      return {
        success: false,
        error:
          `${targetAgent}에 대한 collaborate 호출 빈도가 너무 높습니다. ` +
          `${rateLimitResult.windowMs / 60_000}분 내 최대 ${rateLimitResult.maxAllowed}회입니다. ` +
          `약 ${resetMin}분 후 다시 시도하거나, 기존 스레드에서 직접 대화를 이어가세요.`,
      };
    }
  }

  const mention = `<@${targetBotId}>`;
  const fullContent = `${mention}\n\n${message}`;

  const fromBotUserId =
    params.fromBotUserId ?? (fromAgentId ? getBotUserIdForAgent(fromAgentId) : undefined);

  // Resolve which Discord account should send messages (the calling agent's account)
  const sendAccountId = params.accountId ?? resolvedFromAgent;
  const sendOpts = sendAccountId !== "unknown" ? { accountId: sendAccountId } : {};

  try {
    // ── Path A: Send to existing thread (explicit) ──
    if (threadId) {
      logVerbose("collaborate: sending to existing thread " + threadId);
      const result = await sendMessageDiscord(`channel:${threadId}`, fullContent, sendOpts);
      const messageId = result.messageId;

      registerAndTrack({
        threadId,
        messageId,
        fromBotUserId,
        targetBotId,
        fromAgentId: resolvedFromAgent,
        targetAgent,
        message,
      });

      return {
        success: true,
        messageId,
        threadId,
        note: `${targetAgent}에게 메시지를 전달했습니다. 스레드에서 응답을 기다리세요.`,
      };
    }

    // ── Path B: Use LLM Router when no explicit channelId ──
    let resolvedChannelId = params.channelId;
    let resolvedThreadName = params.threadName;
    let routerThreadId: string | undefined;

    if (!resolvedChannelId && resolvedFromAgent !== "unknown") {
      const routeResult = await routeViaLLM({
        fromAgentId: resolvedFromAgent,
        targetAgent,
        message,
      });

      if (routeResult) {
        resolvedChannelId = routeResult.channelId;
        resolvedThreadName = resolvedThreadName ?? routeResult.threadName;

        // Router may return an existing thread to reuse
        if (routeResult.threadId) {
          routerThreadId = routeResult.threadId;
        }
      }
    }

    // Fallback to currentChannelId if router didn't provide one
    if (!resolvedChannelId) {
      resolvedChannelId = params.currentChannelId;
    }

    // ── Path B-1: Router found an existing thread ──
    if (routerThreadId) {
      logVerbose("collaborate: router matched existing thread " + routerThreadId);
      const result = await sendMessageDiscord(`channel:${routerThreadId}`, fullContent, sendOpts);
      const messageId = result.messageId;

      registerAndTrack({
        threadId: routerThreadId,
        messageId,
        fromBotUserId,
        targetBotId,
        fromAgentId: resolvedFromAgent,
        targetAgent,
        message,
      });

      return {
        success: true,
        messageId,
        threadId: routerThreadId,
        threadName: resolvedThreadName,
        channelId: resolvedChannelId,
        note: `${targetAgent}에게 기존 스레드에서 메시지를 전달했습니다.`,
      };
    }

    // ── Path B-2: Create new thread ──
    if (!resolvedChannelId) {
      return {
        success: false,
        error:
          "채널을 결정할 수 없습니다. ChannelRouter가 설정되지 않았거나, channelId를 직접 지정해주세요.",
      };
    }

    logVerbose("collaborate: creating thread in channel " + resolvedChannelId);
    const name = resolvedThreadName ?? `[협업] ${resolvedFromAgent} · ${targetAgent}`.slice(0, 100);

    const thread = await createThreadDiscord(resolvedChannelId, { name }, sendOpts);
    const newThreadId = thread.id;

    const sendResult = await sendMessageDiscord(`channel:${newThreadId}`, fullContent, sendOpts);
    const messageId = sendResult.messageId;

    registerAndTrack({
      threadId: newThreadId,
      messageId,
      fromBotUserId,
      targetBotId,
      fromAgentId: resolvedFromAgent,
      targetAgent,
      message,
    });

    return {
      success: true,
      messageId,
      threadId: newThreadId,
      threadName: name,
      channelId: resolvedChannelId,
      note: `${targetAgent}에게 메시지를 전달했습니다. 스레드에서 응답을 기다리세요.`,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logVerbose("collaborate: error sending message: " + errorMessage);
    return { success: false, error: errorMessage };
  }
}

// ── Tool Factory ────────────────────────────────────────────────────

export function createCollaborateTool(opts?: {
  agentSessionKey?: string;
  agentAccountId?: string;
  currentChannelId?: string;
}): AnyAgentTool {
  return {
    label: "Collaborate",
    name: "collaborate",
    description:
      "다른 에이전트와 Discord 스레드를 통해 협업합니다. LLM Router가 자동으로 적절한 채널과 스레드를 선택합니다.",
    parameters: CollaborateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const targetAgent = readStringParam(params, "targetAgent", { required: true });
      const message = readStringParam(params, "message", { required: true });
      const threadId = readStringParam(params, "threadId") ?? undefined;
      const channelId = readStringParam(params, "channelId") ?? undefined;
      const threadName = readStringParam(params, "threadName") ?? undefined;

      const fromAgentId = opts?.agentSessionKey
        ? resolveAgentIdFromSessionKey(opts.agentSessionKey)
        : undefined;

      const result = await handleCollaborate({
        targetAgent,
        message,
        threadId,
        channelId,
        threadName,
        fromAgentId,
        accountId: opts?.agentAccountId,
        currentChannelId: opts?.currentChannelId,
      });

      return jsonResult(result);
    },
  };
}
