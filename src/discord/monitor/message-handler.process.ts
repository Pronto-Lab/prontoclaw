import type { User } from "@buape/carbon";
import { ChannelType } from "@buape/carbon";
import crypto from "node:crypto";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { resolveAckReaction, resolveHumanDelayConfig } from "../../agents/identity.js";
import { AGENT_LANE_NESTED } from "../../agents/lanes.js";
import {
  buildRequesterContextSummary,
  buildAgentToAgentMessageContext,
  resolvePingPongTurns,
} from "../../agents/tools/sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "../../agents/tools/sessions-send-tool.a2a.js";
import { resolveChunkMode } from "../../auto-reply/chunk.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { formatInboundEnvelope, resolveEnvelopeFormatOptions } from "../../auto-reply/envelope.js";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
} from "../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  removeAckReactionAfterReply,
  shouldAckReaction as shouldAckReactionGate,
} from "../../channels/ack-reactions.js";
import { logTypingFailure, logAckFailure } from "../../channels/logging.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import { recordInboundSession } from "../../channels/session.js";
import { createTypingCallbacks } from "../../channels/typing.js";
import { loadConfig } from "../../config/config.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../config/sessions.js";
import { callGateway } from "../../gateway/call.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { emit } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../routing/session-key.js";
import { buildUntrustedChannelMetadata } from "../../security/channel-metadata.js";
import { truncateUtf16Safe } from "../../utils.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { markDmResponded, resolveDmRetryConfig } from "../dm-retry/index.js";
import { reactMessageDiscord, removeReactionDiscord } from "../send.js";
import { normalizeDiscordSlug, resolveDiscordOwnerAllowFrom } from "./allow-list.js";
import { resolveTimestampMs } from "./format.js";
import {
  buildDiscordMediaPayload,
  resolveDiscordMessageText,
  resolveMediaList,
} from "./message-utils.js";
import { buildDirectLabel, buildGuildLabel, resolveReplyContext } from "./reply-context.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import { getAgentIdForBot, isSiblingBot } from "./sibling-bots.js";
import { resolveDiscordAutoThreadReplyPlan, resolveDiscordThreadStarter } from "./threading.js";
import { sendTyping } from "./typing.js";

const a2aLog = createSubsystemLogger("discord/a2a-auto-route");

export async function processDiscordMessage(ctx: DiscordMessagePreflightContext) {
  const {
    cfg,
    discordConfig,
    accountId,
    token,
    runtime,
    guildHistories,
    historyLimit,
    mediaMaxBytes,
    textLimit,
    replyToMode,
    ackReactionScope,
    message,
    author,
    sender,
    data,
    client,
    channelInfo,
    channelName,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    baseText,
    messageText,
    shouldRequireMention,
    canDetectMention,
    effectiveWasMentioned,
    shouldBypassMention,
    threadChannel,
    threadParentId,
    threadParentName,
    threadParentType,
    threadName,
    displayChannelSlug,
    guildInfo,
    guildSlug,
    channelConfig,
    baseSessionKey,
    route,
    commandAuthorized,
  } = ctx;

  const mediaList = await resolveMediaList(message, mediaMaxBytes);
  const text = messageText;
  if (!text) {
    logVerbose(`discord: drop message ${message.id} (empty content)`);
    return;
  }

  // ── A2A Auto-Routing ──────────────────────────────────────────────
  // When a sibling bot @mentions us, route through the A2A flow instead
  // of normal message processing.  This injects the sender's conversation
  // context so the receiving agent understands what the sender is working on.
  if (isSiblingBot(author.id) && isGuildMessage && ctx.botUserId) {
    const senderAgentId = getAgentIdForBot(author.id);
    const mentionsUs = message.mentionedUsers?.some((user: User) => user.id === ctx.botUserId);
    if (senderAgentId && mentionsUs) {
      try {
        const freshCfg = loadConfig();

        // Build sender's session key for the channel where the message originated
        const senderSessionKey = buildAgentSessionKey({
          agentId: senderAgentId,
          channel: "discord",
          peer: { kind: "channel", id: message.channelId },
        });

        // Target is the receiving agent (us) — session key from preflight route
        const targetSessionKey = route.sessionKey;

        const requesterContext = await buildRequesterContextSummary(senderSessionKey);

        const enrichedContext = buildAgentToAgentMessageContext({
          requesterSessionKey: senderSessionKey,
          requesterChannel: "discord",
          targetSessionKey,
          config: freshCfg,
          requesterContextSummary: requesterContext,
        });

        const cleanMessage = (baseText ?? text)
          .replace(new RegExp(`<@!?${ctx.botUserId}>`, "g"), "")
          .trim();

        const maxTurns = resolvePingPongTurns(freshCfg);
        const idempotencyKey = crypto.randomUUID();

        a2aLog.info("auto-routing sibling bot mention via A2A", {
          senderAgentId,
          senderSessionKey,
          targetSessionKey,
          channelId: message.channelId,
          maxTurns,
        });

        // Emit a2a.auto_route event for task-hub visibility
        emit({
          type: EVENT_TYPES.A2A_AUTO_ROUTE,
          agentId: senderAgentId,
          ts: Date.now(),
          data: {
            senderAgentId,
            targetAgentId: route.agentId,
            channelId: message.channelId,
            maxTurns,
            message: (cleanMessage || text).slice(0, 200),
          },
        });

        const response = await callGateway<{ runId: string }>({
          method: "agent",
          params: {
            message: cleanMessage || text,
            sessionKey: targetSessionKey,
            idempotencyKey,
            deliver: false,
            channel: INTERNAL_MESSAGE_CHANNEL,
            lane: AGENT_LANE_NESTED,
            extraSystemPrompt: enrichedContext,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: senderSessionKey,
              sourceChannel: "discord",
              sourceTool: "discord_a2a_auto_route",
            },
          },
          timeoutMs: 10_000,
        });

        const runId =
          typeof response?.runId === "string" && response.runId ? response.runId : idempotencyKey;

        void runSessionsSendA2AFlow({
          targetSessionKey,
          displayKey: targetSessionKey,
          message: cleanMessage || text,
          announceTimeoutMs: 120_000,
          maxPingPongTurns: maxTurns,
          requesterSessionKey: senderSessionKey,
          requesterChannel: "discord",
          waitRunId: runId,
        }).catch((err) => {
          a2aLog.warn("A2A auto-route flow failed", {
            error: err instanceof Error ? err.message : String(err),
            senderAgentId,
            targetSessionKey,
          });
        });

        return; // Skip normal message processing
      } catch (err) {
        // Graceful fallback: log and continue to normal processing
        a2aLog.warn("A2A auto-routing failed, falling back to normal processing", {
          error: err instanceof Error ? err.message : String(err),
          authorId: author.id,
          channelId: message.channelId,
        });
      }
    }
  }
  // ── End A2A Auto-Routing ──────────────────────────────────────────
  const ackReaction = resolveAckReaction(cfg, route.agentId);
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ackReactionScope,
        isDirect: isDirectMessage,
        isGroup: isGuildMessage || isGroupDm,
        isMentionableGroup: isGuildMessage,
        requireMention: Boolean(shouldRequireMention),
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention,
      }),
    );
  const ackReactionPromise = shouldAckReaction()
    ? reactMessageDiscord(message.channelId, message.id, ackReaction, {
        rest: client.rest,
      }).then(
        () => true,
        (err) => {
          logVerbose(`discord react failed for channel ${message.channelId}: ${String(err)}`);
          return false;
        },
      )
    : null;

  const fromLabel = isDirectMessage
    ? buildDirectLabel(author)
    : buildGuildLabel({
        guild: data.guild ?? undefined,
        channelName: channelName ?? message.channelId,
        channelId: message.channelId,
      });
  const senderLabel = sender.label;
  const isForumParent =
    threadParentType === ChannelType.GuildForum || threadParentType === ChannelType.GuildMedia;
  const forumParentSlug =
    isForumParent && threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  const threadChannelId = threadChannel?.id;
  const isForumStarter =
    Boolean(threadChannelId && isForumParent && forumParentSlug) && message.id === threadChannelId;
  const forumContextLine = isForumStarter ? `[Forum parent: #${forumParentSlug}]` : null;
  const groupChannel = isGuildMessage && displayChannelSlug ? `#${displayChannelSlug}` : undefined;
  const groupSubject = isDirectMessage ? undefined : groupChannel;
  const untrustedChannelMetadata = isGuildMessage
    ? buildUntrustedChannelMetadata({
        source: "discord",
        label: "Discord channel topic",
        entries: [channelInfo?.topic],
      })
    : undefined;
  const senderName = sender.isPluralKit
    ? (sender.name ?? author.username)
    : (data.member?.nickname ?? author.globalName ?? author.username);
  const senderUsername = sender.isPluralKit
    ? (sender.tag ?? sender.name ?? author.username)
    : author.username;
  const senderTag = sender.tag;
  const systemPromptParts = [channelConfig?.systemPrompt?.trim() || null].filter(
    (entry): entry is string => Boolean(entry),
  );
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
  const ownerAllowFrom = resolveDiscordOwnerAllowFrom({
    channelConfig,
    guildInfo,
    sender: { id: sender.id, name: sender.name, tag: sender.tag },
  });
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  let combinedBody = formatInboundEnvelope({
    channel: "Discord",
    from: fromLabel,
    timestamp: resolveTimestampMs(message.timestamp),
    body: text,
    chatType: isDirectMessage ? "direct" : "channel",
    senderLabel,
    previousTimestamp,
    envelope: envelopeOptions,
  });
  const shouldIncludeChannelHistory =
    !isDirectMessage && !(isGuildMessage && channelConfig?.autoThread && !threadChannel);
  if (shouldIncludeChannelHistory) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: guildHistories,
      historyKey: message.channelId,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Discord",
          from: fromLabel,
          timestamp: entry.timestamp,
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} channel:${message.channelId}]`,
          chatType: "channel",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }
  const replyContext = resolveReplyContext(message, resolveDiscordMessageText);
  if (forumContextLine) {
    combinedBody = `${combinedBody}\n${forumContextLine}`;
  }

  let threadStarterBody: string | undefined;
  let threadLabel: string | undefined;
  let parentSessionKey: string | undefined;
  if (threadChannel) {
    const includeThreadStarter = channelConfig?.includeThreadStarter !== false;
    if (includeThreadStarter) {
      const starter = await resolveDiscordThreadStarter({
        channel: threadChannel,
        client,
        parentId: threadParentId,
        parentType: threadParentType,
        resolveTimestampMs,
      });
      if (starter?.text) {
        // Keep thread starter as raw text; metadata is provided out-of-band in the system prompt.
        threadStarterBody = starter.text;
      }
    }
    const parentName = threadParentName ?? "parent";
    threadLabel = threadName
      ? `Discord thread #${normalizeDiscordSlug(parentName)} › ${threadName}`
      : `Discord thread #${normalizeDiscordSlug(parentName)}`;
    if (threadParentId) {
      parentSessionKey = buildAgentSessionKey({
        agentId: route.agentId,
        channel: route.channel,
        peer: { kind: "channel", id: threadParentId },
      });
    }
  }
  const mediaPayload = buildDiscordMediaPayload(mediaList);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: threadChannel ? message.channelId : undefined,
    parentSessionKey,
    useSuffix: false,
  });
  const replyPlan = await resolveDiscordAutoThreadReplyPlan({
    client,
    message,
    isGuildMessage,
    channelConfig,
    threadChannel,
    baseText: baseText ?? "",
    combinedBody,
    replyToMode,
    agentId: route.agentId,
    channel: route.channel,
  });
  const deliverTarget = replyPlan.deliverTarget;
  const replyTarget = replyPlan.replyTarget;
  const replyReference = replyPlan.replyReference;
  const autoThreadContext = replyPlan.autoThreadContext;

  const effectiveFrom = isDirectMessage
    ? `discord:${author.id}`
    : (autoThreadContext?.From ?? `discord:channel:${message.channelId}`);
  const effectiveTo = autoThreadContext?.To ?? replyTarget;
  if (!effectiveTo) {
    runtime.error?.(danger("discord: missing reply target"));
    return;
  }

  const inboundHistory =
    shouldIncludeChannelHistory && historyLimit > 0
      ? (guildHistories.get(message.channelId) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: baseText ?? text,
    InboundHistory: inboundHistory,
    RawBody: baseText,
    CommandBody: baseText,
    From: effectiveFrom,
    To: effectiveTo,
    SessionKey: autoThreadContext?.SessionKey ?? threadKeys.sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "channel",
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: sender.id,
    SenderUsername: senderUsername,
    SenderTag: senderTag,
    GroupSubject: groupSubject,
    GroupChannel: groupChannel,
    UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : undefined,
    GroupSystemPrompt: isGuildMessage ? groupSystemPrompt : undefined,
    GroupSpace: isGuildMessage ? (guildInfo?.id ?? guildSlug) || undefined : undefined,
    OwnerAllowFrom: ownerAllowFrom,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: effectiveWasMentioned,
    MessageSid: message.id,
    ReplyToId: replyContext?.id,
    ReplyToBody: replyContext?.body,
    ReplyToSender: replyContext?.sender,
    ParentSessionKey: autoThreadContext?.ParentSessionKey ?? threadKeys.parentSessionKey,
    ThreadStarterBody: threadStarterBody,
    ThreadLabel: threadLabel,
    Timestamp: resolveTimestampMs(message.timestamp),
    ...mediaPayload,
    CommandAuthorized: commandAuthorized,
    CommandSource: "text" as const,
    // Originating channel for reply routing.
    OriginatingChannel: "discord" as const,
    OriginatingTo: autoThreadContext?.OriginatingTo ?? replyTarget,
  });

  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: isDirectMessage
      ? {
          sessionKey: route.mainSessionKey,
          channel: "discord",
          to: `user:${author.id}`,
          accountId: route.accountId,
        }
      : undefined,
    onRecordError: (err) => {
      logVerbose(`discord: failed updating session meta: ${String(err)}`);
    },
  });

  if (isDirectMessage) {
    const dmRetryConfig = resolveDmRetryConfig(cfg, accountId);
    if (dmRetryConfig.enabled) {
      try {
        const count = await markDmResponded(message.channelId);
        if (count > 0) {
          logVerbose(
            `dm-retry: marked ${count} DM(s) as responded for channel ${message.channelId}`,
          );
        }
      } catch (err) {
        logVerbose(`dm-retry: failed to mark DM responded: ${String(err)}`);
      }
    }
  }

  if (shouldLogVerbose()) {
    const preview = truncateUtf16Safe(combinedBody, 200).replace(/\n/g, "\\n");
    logVerbose(
      `discord inbound: channel=${message.channelId} deliver=${deliverTarget} from=${ctxPayload.From} preview="${preview}"`,
    );
  }

  const typingChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : message.channelId;

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "discord",
    accountId: route.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "discord",
    accountId,
  });

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...prefixOptions,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    deliver: async (payload: ReplyPayload) => {
      const replyToId = replyReference.use();
      await deliverDiscordReply({
        replies: [payload],
        target: deliverTarget,
        token,
        accountId,
        rest: client.rest,
        runtime,
        replyToId,
        textLimit,
        maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
        tableMode,
        chunkMode: resolveChunkMode(cfg, "discord", accountId),
      });
      replyReference.markSent();
    },
    onError: (err, info) => {
      runtime.error?.(danger(`discord ${info.kind} reply failed: ${String(err)}`));
    },
    onReplyStart: createTypingCallbacks({
      start: () => sendTyping({ client, channelId: typingChannelId }),
      onStartError: (err) => {
        logTypingFailure({
          log: logVerbose,
          channel: "discord",
          target: typingChannelId,
          error: err,
        });
      },
    }).onReplyStart,
  });

  const { queuedFinal, counts } = await dispatchInboundMessage({
    ctx: ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      skillFilter: channelConfig?.skills,
      disableBlockStreaming:
        typeof discordConfig?.blockStreaming === "boolean"
          ? !discordConfig.blockStreaming
          : undefined,
      onModelSelected,
    },
  });
  markDispatchIdle();
  if (!queuedFinal) {
    if (isGuildMessage) {
      clearHistoryEntriesIfEnabled({
        historyMap: guildHistories,
        historyKey: message.channelId,
        limit: historyLimit,
      });
    }
    return;
  }
  if (shouldLogVerbose()) {
    const finalCount = counts.final;
    logVerbose(
      `discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
    );
  }
  removeAckReactionAfterReply({
    removeAfterReply: removeAckAfterReply,
    ackReactionPromise,
    ackReactionValue: ackReaction,
    remove: async () => {
      await removeReactionDiscord(message.channelId, message.id, ackReaction, {
        rest: client.rest,
      });
    },
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: `${message.channelId}/${message.id}`,
        error: err,
      });
    },
  });
  if (isGuildMessage) {
    clearHistoryEntriesIfEnabled({
      historyMap: guildHistories,
      historyKey: message.channelId,
      limit: historyLimit,
    });
  }
}
