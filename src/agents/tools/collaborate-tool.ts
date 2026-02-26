import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { trackOutboundMention } from "../../discord/a2a-retry/index.js";
import { getBotUserIdForAgent, resolveAgentBotUserId } from "../../discord/monitor/sibling-bots.js";
import { registerThreadParticipants } from "../../discord/monitor/thread-participants.js";
import { sendMessageDiscord, createThreadDiscord } from "../../discord/send.js";
import { logVerbose } from "../../globals.js";
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
    Type.String({ description: "새 스레드를 만들 채널 ID (선택, 미지정 시 기본 채널)" }),
  ),
  threadName: Type.Optional(Type.String({ description: "새 스레드 이름 (선택)" })),
});

// ── Helpers ─────────────────────────────────────────────────────────

/** Discord thread names are capped at 100 characters. */
function deriveCollaborateThreadName(
  fromAgent: string,
  targetAgent: string,
  message: string,
): string {
  const firstLine =
    message
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  const prefix = `[협업] ${fromAgent} → ${targetAgent} · `;
  const maxTopicLen = 100 - prefix.length;
  const topic =
    firstLine.slice(0, Math.max(maxTopicLen, 10)) || new Date().toISOString().slice(0, 16);
  // Only add ellipsis if topic was actually truncated; enforce 100 char limit
  const truncated = firstLine.length > maxTopicLen;
  const raw = truncated
    ? `${prefix}${topic.slice(0, Math.max(maxTopicLen - 3, 0))}...`
    : `${prefix}${topic}`;
  return raw.slice(0, 100);
}

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
}): Promise<CollaborateOutput> {
  const { targetAgent, message, threadId, channelId, threadName, fromAgentId } = params;

  logVerbose("collaborate: resolving bot id for agent " + targetAgent);

  // BUG-1 fix: use resolveTargetBotId with config-based fallback
  const targetBotId = resolveTargetBotId(targetAgent);
  if (!targetBotId) {
    return {
      success: false,
      error: `'${targetAgent}'에 대한 Discord 봇 매핑을 찾을 수 없습니다. config에서 agentId '${targetAgent}'의 Discord accountId/봇 바인딩을 확인하세요.`,
    };
  }

  const mention = `<@${targetBotId}>`;
  const fullContent = `${mention}\n\n${message}`;
  const resolvedFromAgent = fromAgentId ?? "unknown";

  // BUG-3 fix: auto-resolve sender's botUserId from agentId if not provided
  const fromBotUserId =
    params.fromBotUserId ?? (fromAgentId ? getBotUserIdForAgent(fromAgentId) : undefined);

  try {
    // ── Path A: Send to existing thread ──
    if (threadId) {
      logVerbose("collaborate: sending to existing thread " + threadId);
      const result = await sendMessageDiscord(`channel:${threadId}`, fullContent);
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

    // ── Path B: Create new thread ──

    // GAP-1 fix: better error message when no channelId
    if (!channelId) {
      return {
        success: false,
        error:
          "threadId 또는 channelId가 필요합니다. " + "새 스레드를 만들려면 channelId를 지정하세요.",
      };
    }

    logVerbose("collaborate: creating thread in channel " + channelId);
    const name = threadName || deriveCollaborateThreadName(resolvedFromAgent, targetAgent, message);

    // BUG-2 fix: create thread WITHOUT content, then send message separately
    // to get the actual messageId (createThreadDiscord doesn't return message ID)
    const thread = await createThreadDiscord(channelId, { name });
    const resolvedThreadId = thread.id;

    // Send the actual message to get a proper messageId
    const sendResult = await sendMessageDiscord(`channel:${resolvedThreadId}`, fullContent);
    const messageId = sendResult.messageId;

    registerAndTrack({
      threadId: resolvedThreadId,
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
      threadId: resolvedThreadId,
      threadName: name,
      channelId,
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
}): AnyAgentTool {
  return {
    label: "Collaborate",
    name: "collaborate",
    description:
      "다른 에이전트와 Discord 스레드를 통해 협업합니다. 세션 타입에 관계없이 사용 가능합니다.",
    parameters: CollaborateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const targetAgent = readStringParam(params, "targetAgent", { required: true });
      const message = readStringParam(params, "message", { required: true });
      const threadId = readStringParam(params, "threadId") ?? undefined;
      const channelId = readStringParam(params, "channelId") ?? undefined;
      const threadName = readStringParam(params, "threadName") ?? undefined;

      // BUG-4 fix: use proper session key parser instead of split(":")[0]
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
      });

      return jsonResult(result);
    },
  };
}
