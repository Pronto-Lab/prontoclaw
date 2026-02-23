import { resolveAgentIdentity } from "../../../agents/identity.js";
import { loadConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { getBotUserIdForAgent } from "../../../discord/monitor/sibling-bots.js";
import { createThreadDiscord } from "../../../discord/send.messages.js";
import { sendMessageDiscord } from "../../../discord/send.outbound.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { subscribe, type CoordinationEvent } from "../bus.js";
import type { ConversationSink, ConversationSinkConfig } from "../conversation-sink.js";
import { EVENT_TYPES } from "../schemas.js";
import { ChannelRouter, type RouteContext } from "./channel-router.js";
import { ThreadRouteCache } from "./thread-route-cache.js";

const log = createSubsystemLogger("discord-conversation-sink");

const A2A_FORWARD_TYPES = new Set([EVENT_TYPES.A2A_SEND, EVENT_TYPES.A2A_RESPONSE]);
const CONVERSATION_MAIN_ROLE = "conversation.main";
const MESSAGE_TRUNCATE_LIMIT = 1900;
const PENDING_TIMEOUT_MS = 60_000;

function extractString(data: Record<string, unknown>, key: string, fallback = ""): string {
  const val = data[key];
  return typeof val === "string" ? val : fallback;
}

interface ThreadInfo {
  threadId: string;
  channelId: string;
  agents: [string, string];
  createdAt: number;
}

interface DiscordConversationSinkOptions {
  guildId: string;
  defaultChannelId: string;
  routerAccountId: string;
  messageAccountId: string;
  reportChannelId?: string;
  notifyUserIds?: string[];
  archivePolicy: string;
  eventFilter: string[];
  routerModel?: string;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function parseOptions(raw: Record<string, unknown>): DiscordConversationSinkOptions {
  return {
    guildId: str(raw.guildId, ""),
    defaultChannelId: str(raw.defaultChannelId, ""),
    routerAccountId: str(raw.routerAccountId, "ruda"),
    messageAccountId: str(raw.messageAccountId, "ruda"),
    reportChannelId: typeof raw.reportChannelId === "string" ? raw.reportChannelId : undefined,
    notifyUserIds: Array.isArray(raw.notifyUserIds) ? (raw.notifyUserIds as string[]) : undefined,
    archivePolicy: str(raw.archivePolicy, "never"),
    eventFilter: Array.isArray(raw.eventFilter)
      ? (raw.eventFilter as string[])
      : [EVENT_TYPES.A2A_SEND, EVENT_TYPES.A2A_RESPONSE],
    routerModel: typeof raw.routerModel === "string" ? raw.routerModel : undefined,
  };
}

function resolveArchiveMinutes(policy: string): number | undefined {
  switch (policy) {
    case "24h":
      return 1440;
    case "3d":
      return 4320;
    case "7d":
      return 10080;
    default:
      return undefined;
  }
}

function resolveFromAgent(event: CoordinationEvent): string {
  const data = event.data ?? {};
  return extractString(data, "fromAgent", "unknown");
}

function formatMessage(event: CoordinationEvent): string | null {
  const data = event.data ?? {};
  const message = extractString(data, "message", "");
  if (!message.trim()) {
    return null;
  }
  const toAgent = extractString(data, "toAgent", "");
  const toBotId = toAgent ? getBotUserIdForAgent(toAgent) : null;
  const mention = toBotId ? `<@${toBotId}> ` : "";
  const truncated =
    message.length > MESSAGE_TRUNCATE_LIMIT
      ? message.slice(0, MESSAGE_TRUNCATE_LIMIT) + "..."
      : message;
  return `${mention}${truncated}`;
}

function shouldForward(event: CoordinationEvent, filterSet: Set<string>): boolean {
  if (!filterSet.has(event.type)) {
    return false;
  }
  const data = event.data ?? {};
  const eventRole = extractString(data, "eventRole", "");
  return eventRole === CONVERSATION_MAIN_ROLE;
}

function extractConversationId(event: CoordinationEvent): string {
  const data = event.data ?? {};
  const conversationId = extractString(data, "conversationId", "");
  if (conversationId) {
    return conversationId;
  }
  const fromAgent = extractString(data, "fromAgent", "");
  const toAgent = extractString(data, "toAgent", "");
  const topicId = extractString(data, "topicId", "");
  return `${[fromAgent, toAgent].toSorted().join("-")}_${topicId || "default"}`;
}

function buildRouteContext(event: CoordinationEvent): RouteContext {
  const data = event.data ?? {};
  const cfg = loadConfig();
  const fromAgent = extractString(data, "fromAgent", "unknown");
  const toAgent = extractString(data, "toAgent", "unknown");
  const message = extractString(data, "message", "");
  const topicId = extractString(data, "topicId", "") || undefined;
  const conversationId = extractConversationId(event);

  const fromIdentity = resolveAgentIdentity(cfg, fromAgent);
  const toIdentity = resolveAgentIdentity(cfg, toAgent);

  return {
    message: message.slice(0, 500),
    fromAgent,
    toAgent,
    fromAgentName: fromIdentity?.name ?? fromAgent,
    toAgentName: toIdentity?.name ?? toAgent,
    topicId,
    conversationId,
  };
}

async function sendToThread(
  threadId: string,
  text: string,
  sendOpts: { accountId: string },
): Promise<void> {
  try {
    await sendMessageDiscord(`channel:${threadId}`, text, sendOpts);
  } catch (err) {
    log.warn("failed to send to thread", { threadId, error: String(err) });
  }
}

async function sendToExistingThread(
  existing: ThreadInfo,
  text: string,
  sendOpts: { accountId: string },
): Promise<void> {
  await sendToThread(existing.threadId, text, sendOpts);
}

export class DiscordConversationSink implements ConversationSink {
  readonly id = "discord-conversation";

  start(config: ConversationSinkConfig): () => void {
    const opts = parseOptions(config.options);

    if (!opts.guildId || !opts.defaultChannelId) {
      log.warn("guildId and defaultChannelId are required");
      return () => {};
    }

    const router = new ChannelRouter({
      guildId: opts.guildId,
      defaultChannelId: opts.defaultChannelId,
      accountId: opts.routerAccountId,
      routerModel: opts.routerModel,
    });

    const stateDir = resolveStateDir();
    const cache = new ThreadRouteCache(stateDir);

    const threadMap = new Map<string, ThreadInfo>();
    const filterSet = new Set(opts.eventFilter);
    const archiveMinutes = resolveArchiveMinutes(opts.archivePolicy);
    let stopped = false;
    const pending = new Map<string, Promise<void>>();

    const cacheReady = cache.load().then(() => {
      for (const [convId, entry] of cache.getAllEntries()) {
        if (!threadMap.has(convId)) {
          threadMap.set(convId, {
            threadId: entry.threadId,
            channelId: entry.channelId,
            agents: entry.agents,
            createdAt: entry.createdAt,
          });
        }
      }
      log.info("thread map hydrated from cache", {
        consoleMessage: `thread map hydrated: ${threadMap.size} entries from persistent cache`,
        count: threadMap.size,
      });
    });

    async function waitForPending(
      conversationId: string,
      text: string,
      sendOpts: { accountId: string },
    ): Promise<boolean> {
      const pendingPromise = pending.get(conversationId);
      if (!pendingPromise) {
        return false;
      }

      const timeoutPromise = new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), PENDING_TIMEOUT_MS);
        pendingPromise.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        );
      });
      const result: "ok" | "timeout" = await Promise.race([
        pendingPromise.then((): "ok" => "ok"),
        timeoutPromise,
      ]);

      if (result === "timeout") {
        log.warn("pending route timed out, will create fresh route", { conversationId });
        return false;
      }

      const resolved = threadMap.get(conversationId);
      if (resolved) {
        await sendToThread(resolved.threadId, text, sendOpts);
      }
      return true;
    }

    async function handleEvent(event: CoordinationEvent): Promise<void> {
      if (stopped) {
        return;
      }
      if (!shouldForward(event, filterSet)) {
        return;
      }

      const text = formatMessage(event);
      if (!text) {
        return;
      }

      await cacheReady;

      const conversationId = extractConversationId(event);
      const fromAgent = resolveFromAgent(event);
      const sendOpts = { accountId: fromAgent };

      const existing = threadMap.get(conversationId);
      if (existing) {
        await sendToExistingThread(existing, text, sendOpts);
        return;
      }

      if (pending.has(conversationId)) {
        const handled = await waitForPending(conversationId, text, sendOpts);
        if (handled) {
          return;
        }
      }

      const routePromise = (async () => {
        try {
          const routeCtx = buildRouteContext(event);

          const data = event.data ?? {};
          const evFromAgent = extractString(data, "fromAgent", "unknown");
          const evToAgent = extractString(data, "toAgent", "unknown");
          const agentPair = [evFromAgent, evToAgent].toSorted() as [string, string];

          const cachedEntry = cache.getByAgentPair(agentPair);
          if (cachedEntry) {
            routeCtx.channelHint = cachedEntry.channelId;
          }

          const result = await router.route(routeCtx);

          log.info("routed conversation", {
            conversationId,
            channelId: result.channelId,
            threadId: result.threadId,
            threadName: result.threadName,
            reasoning: result.reasoning,
            consoleMessage: `routed: ${conversationId} → ch:${result.channelId} thread:${result.threadId ?? "new"} "${result.threadName}" (${result.reasoning})`,
          });

          let threadId = result.threadId;

          if (!threadId) {
            const thread = await createThreadDiscord(
              result.channelId,
              {
                name: result.threadName,
                content: opts.notifyUserIds?.length
                  ? `${opts.notifyUserIds.map((id) => `<@${id}>`).join(" ")} ${text}`
                  : text,
                autoArchiveMinutes: archiveMinutes,
              },
              { accountId: fromAgent },
            );
            threadId = thread.id;
          } else {
            await sendToThread(threadId, text, sendOpts);
          }

          const threadInfo: ThreadInfo = {
            threadId,
            channelId: result.channelId,
            agents: agentPair,
            createdAt: Date.now(),
          };

          threadMap.set(conversationId, threadInfo);

          cache.set(conversationId, {
            threadId,
            channelId: result.channelId,
            threadName: result.threadName,
            agents: agentPair,
            createdAt: Date.now(),
          });

          if (opts.reportChannelId && !result.threadId) {
            const fromBotId = getBotUserIdForAgent(evFromAgent);
            const toBotId = getBotUserIdForAgent(evToAgent);
            const fromRef = fromBotId ? `<@${fromBotId}>` : evFromAgent;
            const toRef = toBotId ? `<@${toBotId}>` : evToAgent;
            const reportText = `🔗 ${fromRef} → ${toRef} | **${result.threadName}** | <#${threadId}>`;
            try {
              await sendMessageDiscord(`channel:${opts.reportChannelId}`, reportText, {
                accountId: opts.routerAccountId,
              });
            } catch (err) {
              log.warn("failed to send report notification", { error: String(err) });
            }
          }
        } catch (err) {
          log.warn("failed to create thread for conversation", {
            conversationId,
            error: String(err),
          });
        } finally {
          pending.delete(conversationId);
        }
      })();

      pending.set(conversationId, routePromise);
      await routePromise;
    }

    const unsubscribes = [...A2A_FORWARD_TYPES].map((type) =>
      subscribe(type, (event) => {
        void handleEvent(event);
      }),
    );

    log.info("discord conversation sink started", {
      guildId: opts.guildId,
      defaultChannelId: opts.defaultChannelId,
    });

    return () => {
      stopped = true;
      for (const unsub of unsubscribes) {
        unsub();
      }
      log.info("discord conversation sink stopped");
    };
  }
}
