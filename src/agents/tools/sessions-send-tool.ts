import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { getA2AConversationId } from "../../infra/events/a2a-index.js";
import { callGateway } from "../../gateway/call.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { resolveAgentWorkspaceDir } from "../agent-scope.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  extractAssistantText,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSessionReference,
  stripToolMessages,
} from "./sessions-helpers.js";
import { buildAgentToAgentMessageContext, resolvePingPongTurns } from "./sessions-send-helpers.js";
import { createAndStartFlow } from "./a2a-job-orchestrator.js";
import { readCurrentTaskId, readTask } from "./task-tool.js";
import { parseA2APayload } from "./a2a-payload-parser.js";
import type { A2APayload } from "./a2a-payload-types.js";

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  taskId: Type.Optional(Type.String()),
  workSessionId: Type.Optional(Type.String()),
  conversationId: Type.Optional(Type.String()),
  parentConversationId: Type.Optional(Type.String()),
  depth: Type.Optional(Type.Number({ minimum: 0 })),
  hop: Type.Optional(Type.Number({ minimum: 0 })),
  message: Type.String(),
  payloadJson: Type.Optional(
    Type.String({
      description:
        "Optional structured payload (JSON). " +
        "One of: task_delegation, status_report, question, answer. " +
        "When provided, intent classification is more accurate and events include the payload type.",
    }),
  ),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

const a2aConversationIdCache = new Map<string, string>();

function buildConversationRouteKey(params: {
  workSessionId?: string;
  requesterAgentId: string;
  targetAgentId: string;
}): string | undefined {
  const workSessionId = normalizeOptionalString(params.workSessionId);
  if (!workSessionId) {
    return undefined;
  }
  const pair = [normalizeAgentId(params.requesterAgentId), normalizeAgentId(params.targetAgentId)]
    .toSorted()
    .join("|");
  return `${workSessionId}::${pair}`;
}

async function resolveA2AConversationId(params: {
  explicitConversationId?: string;
  parentConversationId?: string;
  workSessionId?: string;
  requesterAgentId: string;
  targetAgentId: string;
}): Promise<string | undefined> {
  const explicitConversationId = normalizeOptionalString(params.explicitConversationId);
  const parentConversationId = normalizeOptionalString(params.parentConversationId);
  const routeKey = buildConversationRouteKey({
    workSessionId: params.workSessionId,
    requesterAgentId: params.requesterAgentId,
    targetAgentId: params.targetAgentId,
  });

  const cacheConversationId = (value: string | undefined): string | undefined => {
    if (!value) {
      return undefined;
    }
    if (routeKey) {
      a2aConversationIdCache.set(routeKey, value);
    }
    return value;
  };

  if (explicitConversationId) {
    return cacheConversationId(explicitConversationId);
  }
  if (parentConversationId) {
    return cacheConversationId(parentConversationId);
  }
  if (!routeKey) {
    return undefined;
  }

  const cached = a2aConversationIdCache.get(routeKey);
  if (cached) {
    return cached;
  }

  const fromIndex = await getA2AConversationId(routeKey);
  return cacheConversationId(fromIndex);
}

async function resolveSendWorkSessionContext(params: {
  cfg: ReturnType<typeof loadConfig>;
  requesterAgentId: string;
  requestedTaskId?: string;
  explicitWorkSessionId?: string;
}): Promise<{ workSessionId?: string; taskId?: string }> {
  const explicitWorkSessionId = normalizeOptionalString(params.explicitWorkSessionId);
  let taskId = normalizeOptionalString(params.requestedTaskId);
  if (explicitWorkSessionId) {
    return { workSessionId: explicitWorkSessionId, taskId };
  }

  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.requesterAgentId);

  const readTaskWorkSessionId = async (candidateTaskId?: string): Promise<string | undefined> => {
    if (!candidateTaskId) {
      return undefined;
    }
    try {
      const linkedTask = await readTask(workspaceDir, candidateTaskId);
      return normalizeOptionalString(linkedTask?.workSessionId);
    } catch {
      return undefined;
    }
  };

  const fromRequestedTask = await readTaskWorkSessionId(taskId);
  if (fromRequestedTask) {
    return { workSessionId: fromRequestedTask, taskId };
  }

  try {
    const currentTaskId = await readCurrentTaskId(workspaceDir);
    if (currentTaskId) {
      taskId = taskId ?? currentTaskId;
      const fromCurrentTask = await readTaskWorkSessionId(currentTaskId);
      if (fromCurrentTask) {
        return { workSessionId: fromCurrentTask, taskId };
      }
    }
  } catch {
    // ignore task context resolution errors
  }

  return { taskId };
}

export function createSessionsSendTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session Send",
    name: "sessions_send",
    description:
      "Send a message into another session. Use sessionKey or label to identify the target.",
    parameters: SessionsSendToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const message = readStringParam(params, "message", { required: true });
      const rawPayloadJson = typeof params.payloadJson === "string" ? params.payloadJson.trim() : undefined;
      const parsedPayload: A2APayload | null = rawPayloadJson ? parseA2APayload(rawPayloadJson) : null;
      const taskIdParam = normalizeOptionalString(readStringParam(params, "taskId"));
      const explicitWorkSessionId = normalizeOptionalString(
        readStringParam(params, "workSessionId"),
      );
      const explicitConversationId = normalizeOptionalString(
        readStringParam(params, "conversationId"),
      );
      const parentConversationId = normalizeOptionalString(
        readStringParam(params, "parentConversationId"),
      );
      const depth = normalizeNonNegativeInt(params.depth);
      const hop = normalizeNonNegativeInt(params.hop);
      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const visibility = cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
      const requesterInternalKey =
        typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()
          ? resolveInternalSessionKey({
              key: opts.agentSessionKey,
              alias,
              mainKey,
            })
          : undefined;
      const restrictToSpawned =
        opts?.sandboxed === true &&
        visibility === "spawned" &&
        !!requesterInternalKey &&
        !isSubagentSessionKey(requesterInternalKey);

      const a2aPolicy = createAgentToAgentPolicy(cfg);

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = readStringParam(params, "label")?.trim() || undefined;
      const labelAgentIdParam = readStringParam(params, "agentId")?.trim() || undefined;
      if (sessionKeyParam && labelParam) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Provide either sessionKey or label (not both).",
        });
      }

      const listSessions = async (listParams: Record<string, unknown>) => {
        const result = await callGateway<{ sessions: Array<{ key: string }> }>({
          method: "sessions.list",
          params: listParams,
          timeoutMs: 10_000,
        });
        return Array.isArray(result?.sessions) ? result.sessions : [];
      };

      let sessionKey = sessionKeyParam;
      if (!sessionKey && labelParam) {
        const requesterAgentId = requesterInternalKey
          ? resolveAgentIdFromSessionKey(requesterInternalKey)
          : undefined;
        const requestedAgentId = labelAgentIdParam
          ? normalizeAgentId(labelAgentIdParam)
          : undefined;

        if (
          restrictToSpawned &&
          requestedAgentId &&
          requesterAgentId &&
          requestedAgentId !== requesterAgentId
        ) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_send label lookup is limited to this agent",
          });
        }

        if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
          if (!a2aPolicy.enabled) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            });
          }
          if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            });
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: requesterInternalKey } : {}),
        };
        let resolvedKey = "";
        try {
          const resolved = await callGateway<{ key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = typeof resolved?.key === "string" ? resolved.key.trim() : "";
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: msg || `No session found with label: ${labelParam}`,
          });
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `No session found with label: ${labelParam}`,
          });
        }
        sessionKey = resolvedKey;
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey or label is required",
        });
      }
      const resolvedSession = await resolveSessionReference({
        sessionKey,
        alias,
        mainKey,
        requesterInternalKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }
      // Normalize sessionKey/sessionId input into a canonical session key.
      const resolvedKey = resolvedSession.key;
      const displayKey = resolvedSession.displayKey;
      const resolvedViaSessionId = resolvedSession.resolvedViaSessionId;

      if (restrictToSpawned && !resolvedViaSessionId) {
        const sessions = await listSessions({
          includeGlobal: false,
          includeUnknown: false,
          limit: 500,
          spawnedBy: requesterInternalKey,
        });
        const ok = sessions.some((entry) => entry?.key === resolvedKey);
        if (!ok) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: `Session not visible from this sandboxed agent session: ${sessionKey}`,
            sessionKey: displayKey,
          });
        }
      }
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 30;
      const timeoutMs = timeoutSeconds * 1000;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;
      const requesterAgentId = resolveAgentIdFromSessionKey(requesterInternalKey);
      const targetAgentId = resolveAgentIdFromSessionKey(resolvedKey);
      const { workSessionId, taskId } = await resolveSendWorkSessionContext({
        cfg,
        requesterAgentId,
        requestedTaskId: taskIdParam,
        explicitWorkSessionId,
      });
      const depthValue = depth;
      const hopValue = hop;
      const isCrossAgent = requesterAgentId !== targetAgentId;
      if (isCrossAgent) {
        if (!a2aPolicy.enabled) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error:
              "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            sessionKey: displayKey,
          });
        }
        if (!a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            sessionKey: displayKey,
          });
        }
      }

      const routeKey = buildConversationRouteKey({
        workSessionId,
        requesterAgentId,
        targetAgentId,
      });
      let conversationId = await resolveA2AConversationId({
        explicitConversationId,
        parentConversationId,
        workSessionId,
        requesterAgentId,
        targetAgentId,
      });
      if (!conversationId) {
        conversationId = crypto.randomUUID();
        if (routeKey) {
          a2aConversationIdCache.set(routeKey, conversationId);
        }
      }

      // Use conversation-scoped session key for cross-agent A2A messages
      // so each A2A conversation gets its own session lane (parallel execution).
      const effectiveTargetKey = isCrossAgent
        ? `agent:${targetAgentId}:a2a:${conversationId}`
        : resolvedKey;

      const agentMessageContext = buildAgentToAgentMessageContext({
        requesterSessionKey: opts?.agentSessionKey,
        requesterChannel: opts?.agentChannel,
        targetSessionKey: displayKey,
        config: cfg,
        payload: parsedPayload,
      });
      const sendParams = {
        message,
        sessionKey: effectiveTargetKey,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_NESTED,
        extraSystemPrompt: agentMessageContext,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: opts?.agentSessionKey,
          sourceChannel: opts?.agentChannel,
          sourceTool: "sessions_send",
        },
      };
      const requesterSessionKey = opts?.agentSessionKey;
      const requesterChannel = opts?.agentChannel;
      const maxPingPongTurns = resolvePingPongTurns(cfg);
      const delivery = { status: "pending", mode: "announce" as const };
      const startA2AFlow = (roundOneReply?: string, waitRunId?: string) => {
        void createAndStartFlow({
          jobId: runId,
          targetSessionKey: effectiveTargetKey,
          displayKey,
          message,
          payloadType: parsedPayload?.type,
          payloadJson: parsedPayload ? rawPayloadJson : undefined,
          announceTimeoutMs,
          maxPingPongTurns,
          requesterSessionKey,
          requesterChannel,
          roundOneReply,
          waitRunId,
          conversationId,
          taskId,
          workSessionId,
          parentConversationId,
          depth: depthValue,
          hop: hopValue,
        });
      };

      if (timeoutSeconds === 0) {
        try {
          const response = await callGateway<{ runId: string }>({
            method: "agent",
            params: sendParams,
            timeoutMs: 10_000,
          });
          if (typeof response?.runId === "string" && response.runId) {
            runId = response.runId;
          }
          startA2AFlow(undefined, runId);
          return jsonResult({
            runId,
            status: "accepted",
            sessionKey: displayKey,
            taskId,
            workSessionId,
            conversationId,
            delivery,
          });
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          return jsonResult({
            runId,
            status: "error",
            error: messageText,
            sessionKey: displayKey,
          });
        }
      }

      try {
        const response = await callGateway<{ runId: string }>({
          method: "agent",
          params: sendParams,
          timeoutMs: 10_000,
        });
        if (typeof response?.runId === "string" && response.runId) {
          runId = response.runId;
        }
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        return jsonResult({
          runId,
          status: "error",
          error: messageText,
          sessionKey: displayKey,
        });
      }

      let waitStatus: string | undefined;
      let waitError: string | undefined;
      try {
        const wait = await callGateway<{ status?: string; error?: string }>({
          method: "agent.wait",
          params: {
            runId,
            timeoutMs,
          },
          timeoutMs: timeoutMs + 2000,
        });
        waitStatus = typeof wait?.status === "string" ? wait.status : undefined;
        waitError = typeof wait?.error === "string" ? wait.error : undefined;
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        return jsonResult({
          runId,
          status: messageText.includes("gateway timeout") ? "timeout" : "error",
          error: messageText,
          sessionKey: displayKey,
        });
      }

      if (waitStatus === "timeout") {
        startA2AFlow(undefined, runId);
        return jsonResult({
          runId,
          status: "timeout",
          error: waitError,
          sessionKey: displayKey,
        });
      }
      if (waitStatus === "error") {
        startA2AFlow(undefined, runId);
        return jsonResult({
          runId,
          status: "error",
          error: waitError ?? "agent error",
          sessionKey: displayKey,
        });
      }

      const history = await callGateway<{ messages: Array<unknown> }>({
        method: "chat.history",
        params: { sessionKey: resolvedKey, limit: 50 },
      });
      const filtered = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
      const last = filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
      const reply = last ? extractAssistantText(last) : undefined;
      startA2AFlow(reply ?? undefined);

      return jsonResult({
        runId,
        status: "ok",
        reply,
        sessionKey: displayKey,
        taskId,
        workSessionId,
        conversationId,
        delivery,
        payloadType: parsedPayload?.type,
      });
    },
  };
}
