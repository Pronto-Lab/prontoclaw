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
}) {
  const conversationId = params.conversationId ?? crypto.randomUUID();
  const runContextId = params.waitRunId ?? "unknown";
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
          // "not_found" / "error" → run is gone, stop waiting
          if (wait?.status === "not_found" || wait?.status === "error") {
            log.warn("agent.wait returned non-retriable status", {
              runId: params.waitRunId,
              status: wait?.status,
            });
            break;
          }
        } catch {
          // Gateway connection hiccup — retry
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
      return;
    }

    // Emit a2a.send event
    const fromAgent = params.requesterSessionKey
      ? extractAgentId(params.requesterSessionKey)
      : "unknown";
    const toAgent = extractAgentId(params.targetSessionKey);
    emit({
      type: EVENT_TYPES.A2A_SEND,
      agentId: fromAgent,
      ts: Date.now(),
      data: {
        fromAgent,
        toAgent,
        targetSessionKey: params.targetSessionKey,
        message: params.message.slice(0, 200),
        runId: runContextId,
        conversationId,
      },
    });

    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";

    if (
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
        emit({
          type: EVENT_TYPES.A2A_RESPONSE,
          agentId: extractAgentId(currentSessionKey),
          ts: Date.now(),
          data: {
            fromAgent: extractAgentId(currentSessionKey),
            toAgent: extractAgentId(nextSessionKey),
            turn,
            maxTurns: params.maxPingPongTurns,
            replyPreview: replyText.slice(0, 200),
            conversationId,
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
        announced: !!(
          announceTarget &&
          announceReply &&
          announceReply.trim() &&
          !isAnnounceSkip(announceReply)
        ),
        targetSessionKey: params.targetSessionKey,
        conversationId,
      },
    });
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}
