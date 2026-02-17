import crypto from "node:crypto";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emit } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { readLatestAssistantReply, runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isReplySkip,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

function extractAgentId(sessionKey: string): string {
  const parts = sessionKey.split(":");
  return parts.length >= 2 ? parts[1] : sessionKey;
}

function sessionTypeFromSessionKey(sessionKey?: string): "main" | "subagent" | "unknown" {
  if (!sessionKey) {
    return "unknown";
  }
  if (sessionKey.includes(":subagent:")) {
    return "subagent";
  }
  if (/^agent:[^:]+:main$/i.test(sessionKey)) {
    return "main";
  }
  return "unknown";
}

function resolveA2AEventRole(params: {
  fromSessionType: "main" | "subagent" | "unknown";
  toSessionType: "main" | "subagent" | "unknown";
}): "conversation.main" | "delegation.subagent" {
  return params.fromSessionType === "subagent" || params.toSessionType === "subagent"
    ? "delegation.subagent"
    : "conversation.main";
}

function sanitizeA2AConversationText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  // Hide internal orchestration directives from user-facing conversation surfaces.
  const stripped = normalized.replace(/^\s*\[\[[a-z0-9_:-]+\]\]\s*\n?/gim, "").trim();
  return stripped || normalized;
}

function toA2AReplyPreview(text: string): string {
  return sanitizeA2AConversationText(text).slice(0, 200);
}

function toA2ASendMessage(text: string): string {
  // Keep enough context for UI thread rendering while still bounding log payload size.
  return sanitizeA2AConversationText(text).slice(0, 4000);
}

export async function runSessionsSendA2AFlow(params: {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
  conversationId?: string;
  taskId?: string;
  workSessionId?: string;
  parentConversationId?: string;
  depth?: number;
  hop?: number;
  skipPingPong?: boolean;
}) {
  const conversationId = params.conversationId ?? crypto.randomUUID();
  const runContextId = params.waitRunId ?? "unknown";
  const fromAgent = params.requesterSessionKey
    ? extractAgentId(params.requesterSessionKey)
    : "unknown";
  const toAgent = extractAgentId(params.targetSessionKey);
  const fromSessionType = sessionTypeFromSessionKey(params.requesterSessionKey);
  const toSessionType = sessionTypeFromSessionKey(params.targetSessionKey);
  const eventRole = resolveA2AEventRole({ fromSessionType, toSessionType });
  const sharedContext = {
    taskId: params.taskId,
    workSessionId: params.workSessionId,
    parentConversationId: params.parentConversationId,
    depth: params.depth,
    hop: params.hop,
  };

  // Emit a2a.send immediately so conversation streams can render outbound intent,
  // even when downstream reply generation is delayed or skipped.
  emit({
    type: EVENT_TYPES.A2A_SEND,
    agentId: fromAgent,
    ts: Date.now(),
    data: {
      fromAgent,
      toAgent,
      targetSessionKey: params.targetSessionKey,
      message: toA2ASendMessage(params.message),
      runId: runContextId,
      conversationId,
      eventRole,
      fromSessionType,
      toSessionType,
      ...sharedContext,
    },
  });

  try {
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;
    if (!primaryReply && params.waitRunId) {
      // Retry-based wait: instead of a single timeout that silently gives up,
      // poll agent.wait in 30s chunks.  agent.wait returns immediately when the
      // run completes, so this is NOT busy-polling — each chunk is event-driven
      // on the gateway side.  We only loop to survive transient timeouts.
      const CHUNK_MS = 30_000;
      const MAX_WAIT_MS = 300_000; // 5 min absolute ceiling
      let elapsed = 0;
      while (elapsed < MAX_WAIT_MS) {
        try {
          const wait = await callGateway<{ status: string }>({
            method: "agent.wait",
            params: {
              runId: params.waitRunId,
              timeoutMs: CHUNK_MS,
            },
            timeoutMs: CHUNK_MS + 5_000,
          });
          if (wait?.status === "ok") {
            primaryReply = await readLatestAssistantReply({
              sessionKey: params.targetSessionKey,
            });
            latestReply = primaryReply;
            break;
          }
          // "not_found" / "error" -> run is gone, stop waiting
          if (wait?.status === "not_found" || wait?.status === "error") {
            log.warn("agent.wait returned non-retriable status", {
              runId: params.waitRunId,
              status: wait?.status,
            });
            break;
          }
        } catch {
          // Gateway connection hiccup -> retry
        }
        elapsed += CHUNK_MS;
      }
      if (elapsed >= MAX_WAIT_MS) {
        log.warn("agent.wait exhausted max wait ceiling", {
          runId: params.waitRunId,
          maxWaitMs: MAX_WAIT_MS,
        });
      }
    }

    if (!latestReply) {
      emit({
        type: EVENT_TYPES.A2A_COMPLETE,
        agentId: fromAgent,
        ts: Date.now(),
        data: {
          fromAgent,
          toAgent,
          announced: false,
          targetSessionKey: params.targetSessionKey,
          conversationId,
          eventRole,
          fromSessionType,
          toSessionType,
          ...sharedContext,
        },
      });
      return;
    }

    // Emit initial target reply so main-agent conversations render bilateral exchange.
    const initialResponseFromSessionType = sessionTypeFromSessionKey(params.targetSessionKey);
    const initialResponseToSessionType = sessionTypeFromSessionKey(params.requesterSessionKey);
    const initialResponseEventRole = resolveA2AEventRole({
      fromSessionType: initialResponseFromSessionType,
      toSessionType: initialResponseToSessionType,
    });
    emit({
      type: EVENT_TYPES.A2A_RESPONSE,
      agentId: toAgent,
      ts: Date.now(),
      data: {
        fromAgent: toAgent,
        toAgent: fromAgent,
        message: sanitizeA2AConversationText(latestReply),
        replyPreview: toA2AReplyPreview(latestReply),
        conversationId,
        eventRole: initialResponseEventRole,
        fromSessionType: initialResponseFromSessionType,
        toSessionType: initialResponseToSessionType,
        ...sharedContext,
      },
    });

    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";

    const shouldSkipPingPong =
      params.skipPingPong || /\[NO_REPLY_NEEDED\]|\[NOTIFICATION\]/i.test(params.message);

    if (
      !shouldSkipPingPong &&
      params.maxPingPongTurns > 0 &&
      params.requesterSessionKey &&
      params.requesterSessionKey !== params.targetSessionKey
    ) {
      let currentSessionKey = params.requesterSessionKey;
      let nextSessionKey = params.targetSessionKey;
      let incomingMessage = latestReply;
      for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
        const currentRole =
          currentSessionKey === params.requesterSessionKey ? "requester" : "target";
        const replyPrompt = buildAgentToAgentReplyContext({
          requesterSessionKey: params.requesterSessionKey,
          requesterChannel: params.requesterChannel,
          targetSessionKey: params.displayKey,
          targetChannel,
          currentRole,
          turn,
          maxTurns: params.maxPingPongTurns,
        });
        const replyText = await runAgentStep({
          sessionKey: currentSessionKey,
          message: incomingMessage,
          extraSystemPrompt: replyPrompt,
          timeoutMs: params.announceTimeoutMs,
          lane: AGENT_LANE_NESTED,
          sourceSessionKey: nextSessionKey,
          sourceChannel:
            nextSessionKey === params.requesterSessionKey ? params.requesterChannel : targetChannel,
          sourceTool: "sessions_send",
        });
        if (!replyText || isReplySkip(replyText)) {
          break;
        }

        // Emit a2a.response event
        const responseFromSessionType = sessionTypeFromSessionKey(currentSessionKey);
        const responseToSessionType = sessionTypeFromSessionKey(nextSessionKey);
        const responseEventRole = resolveA2AEventRole({
          fromSessionType: responseFromSessionType,
          toSessionType: responseToSessionType,
        });
        emit({
          type: EVENT_TYPES.A2A_RESPONSE,
          agentId: extractAgentId(currentSessionKey),
          ts: Date.now(),
          data: {
            fromAgent: extractAgentId(currentSessionKey),
            toAgent: extractAgentId(nextSessionKey),
            turn,
            maxTurns: params.maxPingPongTurns,
            message: sanitizeA2AConversationText(replyText),
            replyPreview: toA2AReplyPreview(replyText),
            conversationId,
            eventRole: responseEventRole,
            fromSessionType: responseFromSessionType,
            toSessionType: responseToSessionType,
            ...sharedContext,
          },
        });

        latestReply = replyText;
        incomingMessage = replyText;
        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;
      }
    }

    const announcePrompt = buildAgentToAgentAnnounceContext({
      requesterSessionKey: params.requesterSessionKey,
      requesterChannel: params.requesterChannel,
      targetSessionKey: params.displayKey,
      targetChannel,
      originalMessage: params.message,
      roundOneReply: primaryReply,
      latestReply,
    });
    const announceReply = await runAgentStep({
      sessionKey: params.targetSessionKey,
      message: "Agent-to-agent announce step.",
      extraSystemPrompt: announcePrompt,
      timeoutMs: params.announceTimeoutMs,
      lane: AGENT_LANE_NESTED,
      sourceSessionKey: params.requesterSessionKey,
      sourceChannel: params.requesterChannel,
      sourceTool: "sessions_send",
    });

    let announced = false;
    if (announceTarget && announceReply && announceReply.trim() && !isAnnounceSkip(announceReply)) {
      try {
        await callGateway({
          method: "send",
          params: {
            to: announceTarget.to,
            message: announceReply.trim(),
            channel: announceTarget.channel,
            accountId: announceTarget.accountId,
            idempotencyKey: crypto.randomUUID(),
          },
          timeoutMs: 10_000,
        });
        announced = true;
      } catch (err) {
        log.warn("sessions_send announce delivery failed", {
          runId: runContextId,
          channel: announceTarget.channel,
          to: announceTarget.to,
          error: formatErrorMessage(err),
        });
      }
    }

    // Emit a2a.complete event
    emit({
      type: EVENT_TYPES.A2A_COMPLETE,
      agentId: fromAgent,
      ts: Date.now(),
      data: {
        fromAgent,
        toAgent,
        announced,
        targetSessionKey: params.targetSessionKey,
        conversationId,
        eventRole,
        fromSessionType,
        toSessionType,
        ...sharedContext,
      },
    });
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}
