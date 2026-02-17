import crypto from "node:crypto";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emit } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { classifyA2AError, calculateBackoffMs } from "./a2a-error-classification.js";
import {
  classifyMessageIntent,
  resolveEffectivePingPongTurns,
  shouldTerminatePingPong,
  shouldRunAnnounce,
} from "./a2a-intent-classifier.js";
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

function buildNoReplyOutcomeMessage(params: {
  waitStatus?: string;
  waitError?: string;
  maxWaitExceeded: boolean;
  maxWaitMs: number;
}): string {
  const reasonFromError =
    typeof params.waitError === "string" && params.waitError.trim() ? params.waitError.trim() : "";

  if (reasonFromError) {
    return `[outcome] blocked: 응답을 받지 못했습니다 (${reasonFromError})`;
  }

  if (params.waitStatus === "not_found") {
    return "[outcome] blocked: 응답을 받지 못했습니다 (실행 상태를 찾을 수 없음)";
  }

  if (params.waitStatus === "error") {
    return "[outcome] blocked: 응답을 받지 못했습니다 (실행 오류)";
  }

  if (params.maxWaitExceeded || params.waitStatus === "timeout") {
    return `[outcome] blocked: 응답을 받지 못했습니다 (대기 시간 ${Math.floor(params.maxWaitMs / 1000)}초 초과)`;
  }

  return "[outcome] blocked: 응답을 받지 못했습니다";
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
    let waitStatus: string | undefined;
    let waitError: string | undefined;
    let maxWaitExceeded = false;
    if (!primaryReply && params.waitRunId) {
      // Retry-aware wait: poll agent.wait in chunks, classify errors, apply backoff.
      const CHUNK_MS = 30_000;
      const MAX_WAIT_MS = 300_000; // 5 min absolute ceiling
      const MAX_RETRIES = 3; // Max retries for transient/unknown errors
      let elapsed = 0;
      let retryCount = 0;

      while (elapsed < MAX_WAIT_MS) {
        let errorInfo: ReturnType<typeof classifyA2AError> | undefined;

        try {
          const wait = await callGateway<{ status?: string; error?: string }>({
            method: "agent.wait",
            params: {
              runId: params.waitRunId,
              timeoutMs: CHUNK_MS,
            },
            timeoutMs: CHUNK_MS + 5_000,
          });
          waitStatus = typeof wait?.status === "string" ? wait.status : undefined;
          waitError = typeof wait?.error === "string" ? wait.error : undefined;

          if (wait?.status === "ok") {
            primaryReply = await readLatestAssistantReply({
              sessionKey: params.targetSessionKey,
            });
            latestReply = primaryReply;
            break;
          }

          // Classify non-ok wait responses
          errorInfo = classifyA2AError(wait ?? { status: "error", error: "null response" });
        } catch (err) {
          // Gateway connection failure — classify it
          errorInfo = classifyA2AError(err instanceof Error ? err : new Error(String(err)));
          log.debug("agent.wait gateway hiccup", {
            runId: params.waitRunId,
            error: errorInfo.reason,
          });
        }

        // Error handling with classification
        if (errorInfo) {
          if (!errorInfo.retriable) {
            log.warn("a2a.wait: non-retriable error, stopping", {
              category: errorInfo.category,
              code: errorInfo.code,
              reason: errorInfo.reason,
              runId: params.waitRunId,
            });
            break;
          }

          retryCount++;
          if (retryCount > MAX_RETRIES) {
            log.warn("a2a.wait: max retries exceeded", {
              retryCount,
              category: errorInfo.category,
              code: errorInfo.code,
              runId: params.waitRunId,
            });
            break;
          }

          const backoffMs = calculateBackoffMs(retryCount - 1);

          // Emit retry event for monitoring
          emit({
            type: EVENT_TYPES.A2A_RETRY,
            agentId: toAgent,
            ts: Date.now(),
            data: {
              fromAgent,
              toAgent,
              runId: params.waitRunId,
              attempt: retryCount,
              maxAttempts: MAX_RETRIES,
              errorCategory: errorInfo.category,
              errorCode: errorInfo.code,
              reason: errorInfo.reason,
              backoffMs,
              elapsedMs: elapsed,
              conversationId,
              ...sharedContext,
            },
          });

          log.info("a2a.wait: retrying after backoff", {
            attempt: retryCount,
            backoffMs,
            category: errorInfo.category,
            code: errorInfo.code,
            elapsed,
          });

          await new Promise((r) => setTimeout(r, backoffMs));
          elapsed += backoffMs;
        }

        elapsed += CHUNK_MS;
      }

      if (elapsed >= MAX_WAIT_MS) {
        waitStatus = waitStatus || "timeout";
        maxWaitExceeded = true;
        log.warn("agent.wait exhausted max wait ceiling", {
          runId: params.waitRunId,
          maxWaitMs: MAX_WAIT_MS,
          retryCount,
        });
      }
    }

    if (!latestReply) {
      const noReplyFromSessionType = sessionTypeFromSessionKey(params.targetSessionKey);
      const noReplyToSessionType = sessionTypeFromSessionKey(params.requesterSessionKey);
      const noReplyEventRole = resolveA2AEventRole({
        fromSessionType: noReplyFromSessionType,
        toSessionType: noReplyToSessionType,
      });
      const noReplyMessage = buildNoReplyOutcomeMessage({
        waitStatus,
        waitError,
        maxWaitExceeded,
        maxWaitMs: 300_000,
      });
      emit({
        type: EVENT_TYPES.A2A_RESPONSE,
        agentId: toAgent,
        ts: Date.now(),
        data: {
          fromAgent: toAgent,
          toAgent: fromAgent,
          message: noReplyMessage,
          replyPreview: toA2AReplyPreview(noReplyMessage),
          outcome: "blocked",
          waitStatus,
          waitError,
          conversationId,
          eventRole: noReplyEventRole,
          fromSessionType: noReplyFromSessionType,
          toSessionType: noReplyToSessionType,
          ...sharedContext,
        },
      });

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
          waitStatus,
          waitError,
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

    // Intent-based ping-pong optimization (Design #4)
    const intentResult = classifyMessageIntent(params.message);
    const effectiveTurns = resolveEffectivePingPongTurns({
      configMaxTurns: params.maxPingPongTurns,
      classifiedIntent: intentResult,
      explicitSkipPingPong: params.skipPingPong ?? false,
    });

    let actualTurns = 0;
    let earlyTermination = false;
    let terminationReason = "";
    const previousReplies: string[] = [];

    if (
      effectiveTurns > 0 &&
      params.requesterSessionKey &&
      params.requesterSessionKey !== params.targetSessionKey
    ) {
      let currentSessionKey = params.requesterSessionKey;
      let nextSessionKey = params.targetSessionKey;
      let incomingMessage = latestReply;
      for (let turn = 1; turn <= effectiveTurns; turn += 1) {
        const currentRole =
          currentSessionKey === params.requesterSessionKey ? "requester" : "target";
        const previousTurnSummary =
          previousReplies.length > 0
            ? previousReplies.map((r, i) => `Turn ${i + 1}: ${r.slice(0, 200)}`).join("\n")
            : undefined;
        const replyPrompt = buildAgentToAgentReplyContext({
          requesterSessionKey: params.requesterSessionKey,
          requesterChannel: params.requesterChannel,
          targetSessionKey: params.displayKey,
          targetChannel,
          currentRole,
          turn,
          maxTurns: effectiveTurns,
          originalMessage: params.message,
          messageIntent: intentResult.intent,
          previousTurnSummary,
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
          earlyTermination = true;
          terminationReason = "explicit_skip";
          break;
        }

        // System-level early termination (Design #4)
        const termination = shouldTerminatePingPong({
          replyText,
          turn,
          maxTurns: effectiveTurns,
          previousReplies,
        });
        if (termination.terminate) {
          earlyTermination = true;
          terminationReason = termination.reason;
          log.debug("ping-pong early termination", {
            turn,
            reason: termination.reason,
            conversationId,
          });
          // Still emit the final response before breaking
        }

        actualTurns = turn;

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
            maxTurns: effectiveTurns,
            message: sanitizeA2AConversationText(replyText),
            replyPreview: toA2AReplyPreview(replyText),
            conversationId,
            eventRole: responseEventRole,
            fromSessionType: responseFromSessionType,
            toSessionType: responseToSessionType,
            messageIntent: intentResult.intent,
            terminationReason: termination.terminate ? termination.reason : undefined,
            ...sharedContext,
          },
        });

        if (termination.terminate) {
          break;
        }

        previousReplies.push(replyText);
        latestReply = replyText;
        incomingMessage = replyText;
        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;
      }
    }

    // Conditional announce (Design #4) — skip if no target or no reply
    let announced = false;
    if (announceTarget && shouldRunAnnounce({ announceTarget, latestReply })) {
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

      if (announceReply && announceReply.trim() && !isAnnounceSkip(announceReply)) {
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
    }

    // Emit a2a.complete event with optimization metadata
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
        messageIntent: intentResult.intent,
        configuredMaxTurns: params.maxPingPongTurns,
        effectiveTurns,
        actualTurns,
        earlyTermination,
        terminationReason: terminationReason || undefined,
        announceSkipped: !shouldRunAnnounce({ announceTarget, latestReply }),
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
