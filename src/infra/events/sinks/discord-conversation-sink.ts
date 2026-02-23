import { resolveAgentIdentity } from "../../../agents/identity.js";
import { loadConfig } from "../../../config/config.js";
import { getBotUserIdForAgent } from "../../../discord/monitor/sibling-bots.js";
import { createThreadDiscord } from "../../../discord/send.messages.js";
import { sendMessageDiscord } from "../../../discord/send.outbound.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { subscribe, type CoordinationEvent } from "../bus.js";
import type { ConversationSink, ConversationSinkConfig } from "../conversation-sink.js";
import { EVENT_TYPES } from "../schemas.js";
import { ChannelRouter, type RouteContext } from "./channel-router.js";

const log = createSubsystemLogger("discord-conversation-sink");

const A2A_FORWARD_TYPES = new Set([EVENT_TYPES.A2A_SEND, EVENT_TYPES.A2A_RESPONSE]);
const CONVERSATION_MAIN_ROLE = "conversation.main";
const MESSAGE_TRUNCATE_LIMIT = 1900;

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
  return typeof data.fromAgent === "string" ? data.fromAgent : "unknown";
}

function formatMessage(event: CoordinationEvent): string | null {
  const data = event.data ?? {};
  const message = typeof data.message === "string" ? data.message : "";
  if (!message.trim()) {
    return null;
  }

  const fromAgent = typeof data.fromAgent === "string" ? data.fromAgent : "unknown";
  const toAgent = typeof data.toAgent === "string" ? data.toAgent : "unknown";

  const fromBotId = getBotUserIdForAgent(fromAgent);
  const toBotId = getBotUserIdForAgent(toAgent);

  const fromMention = fromBotId ? `<@${fromBotId}>` : fromAgent;
  const toMention = toBotId ? `<@${toBotId}>` : toAgent;

  const truncated =
    message.length > MESSAGE_TRUNCATE_LIMIT
      ? message.slice(0, MESSAGE_TRUNCATE_LIMIT) + "..."
      : message;

  return `${fromMention} → ${toMention}\n\n${truncated}`;
}

function shouldForward(event: CoordinationEvent, filterSet: Set<string>): boolean {
  if (!filterSet.has(event.type)) {
    return false;
  }
  const data = event.data ?? {};
  const eventRole = typeof data.eventRole === "string" ? data.eventRole : "";
  return eventRole === CONVERSATION_MAIN_ROLE;
}

function extractConversationId(event: CoordinationEvent): string {
  const data = event.data ?? {};
  const conversationId = typeof data.conversationId === "string" ? data.conversationId : "";
  if (conversationId) {
    return conversationId;
  }
  const fromAgent = typeof data.fromAgent === "string" ? data.fromAgent : "";
  const toAgent = typeof data.toAgent === "string" ? data.toAgent : "";
  const topicId = typeof data.topicId === "string" ? data.topicId : "";
  return `${[fromAgent, toAgent].toSorted().join("-")}_${topicId || "default"}`;
}

function buildRouteContext(event: CoordinationEvent): RouteContext {
  const data = event.data ?? {};
  const cfg = loadConfig();
  const fromAgent = typeof data.fromAgent === "string" ? data.fromAgent : "unknown";
  const toAgent = typeof data.toAgent === "string" ? data.toAgent : "unknown";
  const message = typeof data.message === "string" ? data.message : "";
  const topicId = typeof data.topicId === "string" ? data.topicId : undefined;
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

    const threadMap = new Map<string, ThreadInfo>();
    const filterSet = new Set(opts.eventFilter);
    const archiveMinutes = resolveArchiveMinutes(opts.archivePolicy);
    let stopped = false;
    const pending = new Map<string, Promise<void>>();

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

      const conversationId = extractConversationId(event);
      const fromAgent = resolveFromAgent(event);
      const sendOpts = { accountId: fromAgent };

      const existing = threadMap.get(conversationId);
      if (existing) {
        try {
          await sendMessageDiscord(`channel:${existing.threadId}`, text, sendOpts);
        } catch (err) {
          log.warn("failed to send to existing thread", {
            threadId: existing.threadId,
            error: String(err),
          });
        }
        return;
      }

      // Prevent duplicate thread creation for same conversationId
      if (pending.has(conversationId)) {
        await pending.get(conversationId);
        const resolved = threadMap.get(conversationId);
        if (resolved) {
          try {
            await sendMessageDiscord(`channel:${resolved.threadId}`, text, sendOpts);
          } catch (err) {
            log.warn("failed to send after pending resolution", { error: String(err) });
          }
        }
        return;
      }

      const routePromise = (async () => {
        try {
          const routeCtx = buildRouteContext(event);
          const result = await router.route(routeCtx);

          log.info("routed conversation", {
            conversationId,
            channelId: result.channelId,
            threadId: result.threadId,
            threadName: result.threadName,
            reasoning: result.reasoning,
          });

          let threadId = result.threadId;

          if (!threadId) {
            const thread = await createThreadDiscord(
              result.channelId,
              {
                name: result.threadName,
                content: text,
                autoArchiveMinutes: archiveMinutes,
              },
              { accountId: fromAgent },
            );
            threadId = thread.id;
          } else {
            await sendMessageDiscord(`channel:${threadId}`, text, sendOpts);
          }

          const data = event.data ?? {};
          const evFromAgent = typeof data.fromAgent === "string" ? data.fromAgent : "unknown";
          const evToAgent = typeof data.toAgent === "string" ? data.toAgent : "unknown";

          threadMap.set(conversationId, {
            threadId,
            channelId: result.channelId,
            agents: [evFromAgent, evToAgent].toSorted() as [string, string],
            createdAt: Date.now(),
          });

          // Report new thread to the reporting channel
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
