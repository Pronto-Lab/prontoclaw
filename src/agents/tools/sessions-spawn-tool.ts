import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { formatThinkingLevels, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { emit } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "../agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { buildSubagentSystemPrompt } from "../subagent-announce.js";
import { registerSubagentRun } from "../subagent-registry.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";
import { readCurrentTaskId, readTask } from "./task-tool.js";

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  taskId: Type.Optional(Type.String()),
  workSessionId: Type.Optional(Type.String()),
  parentConversationId: Type.Optional(Type.String()),
  depth: Type.Optional(Type.Number({ minimum: 0 })),
  hop: Type.Optional(Type.Number({ minimum: 0 })),
  label: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat alias. Prefer runTimeoutSeconds.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
});

function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const [provider, model] = trimmed.split("/", 2);
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  return undefined;
}

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

async function resolveSpawnWorkSessionContext(params: {
  cfg: ReturnType<typeof loadConfig>;
  requesterAgentId: string;
  requestedTaskId?: string;
  explicitWorkSessionId?: string;
}): Promise<{ workSessionId: string; taskId?: string }> {
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

  return { workSessionId: `ws_${crypto.randomUUID()}`, taskId };
}

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      "Spawn a background sub-agent run in an isolated session and announce the result back to the requester chat.",
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const taskIdParam = normalizeOptionalString(readStringParam(params, "taskId"));
      const explicitWorkSessionId = normalizeOptionalString(
        readStringParam(params, "workSessionId"),
      );
      const parentConversationId = normalizeOptionalString(
        readStringParam(params, "parentConversationId"),
      );
      const depth = normalizeNonNegativeInt(params.depth);
      const hop = normalizeNonNegativeInt(params.hop);
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const requesterOrigin = normalizeDeliveryContext({
        channel: opts?.agentChannel,
        accountId: opts?.agentAccountId,
        to: opts?.agentTo,
        threadId: opts?.agentThreadId,
      });
      const runTimeoutSeconds = (() => {
        const explicit =
          typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
            ? Math.max(0, Math.floor(params.runTimeoutSeconds))
            : undefined;
        if (explicit !== undefined) {
          return explicit;
        }
        const legacy =
          typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
            ? Math.max(0, Math.floor(params.timeoutSeconds))
            : undefined;
        return legacy ?? 0;
      })();
      let modelWarning: string | undefined;
      let modelApplied = false;

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey;
      if (typeof requesterSessionKey === "string" && isSubagentSessionKey(requesterSessionKey)) {
        return jsonResult({
          status: "forbidden",
          error: "sessions_spawn is not allowed from sub-agent sessions",
        });
      }
      const requesterInternalKey = requesterSessionKey
        ? resolveInternalSessionKey({
            key: requesterSessionKey,
            alias,
            mainKey,
          })
        : alias;
      const requesterDisplayKey = resolveDisplaySessionKey({
        key: requesterInternalKey,
        alias,
        mainKey,
      });

      const requesterAgentId = normalizeAgentId(
        opts?.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
      );
      const targetAgentId = requestedAgentId
        ? normalizeAgentId(requestedAgentId)
        : requesterAgentId;
      if (targetAgentId !== requesterAgentId) {
        const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
        const allowAny = allowAgents.some((value) => value.trim() === "*");
        const normalizedTargetId = targetAgentId.toLowerCase();
        const allowSet = new Set(
          allowAgents
            .filter((value) => value.trim() && value.trim() !== "*")
            .map((value) => normalizeAgentId(value).toLowerCase()),
        );
        if (!allowAny && !allowSet.has(normalizedTargetId)) {
          const allowedText = allowAny
            ? "*"
            : allowSet.size > 0
              ? Array.from(allowSet).join(", ")
              : "none";
          return jsonResult({
            status: "forbidden",
            error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
          });
        }
      }
      const childSessionKey = "agent:" + targetAgentId + ":subagent:" + crypto.randomUUID();
      const spawnedByKey = requesterInternalKey;
      const { workSessionId, taskId } = await resolveSpawnWorkSessionContext({
        cfg,
        requesterAgentId,
        requestedTaskId: taskIdParam,
        explicitWorkSessionId,
      });
      const conversationId = parentConversationId ?? crypto.randomUUID();
      const depthValue = depth ?? 0;
      const hopValue = hop ?? 0;
      const spawnRequestPreview = task.slice(0, 200);
      emit({
        type: EVENT_TYPES.A2A_SPAWN,
        agentId: requesterAgentId,
        ts: Date.now(),
        data: {
          fromAgent: requesterAgentId,
          toAgent: targetAgentId,
          targetSessionKey: childSessionKey,
          message: spawnRequestPreview,
          replyPreview: spawnRequestPreview,
          conversationId,
          parentConversationId,
          taskId,
          workSessionId,
          depth: depthValue,
          hop: hopValue,
          label: label || undefined,
        },
      });
      emit({
        type: EVENT_TYPES.A2A_SEND,
        agentId: requesterAgentId,
        ts: Date.now(),
        data: {
          fromAgent: requesterAgentId,
          toAgent: targetAgentId,
          targetSessionKey: childSessionKey,
          message: spawnRequestPreview,
          replyPreview: spawnRequestPreview,
          conversationId,
          parentConversationId,
          taskId,
          workSessionId,
          depth: depthValue,
          hop: hopValue,
        },
      });
      const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
      const resolvedModel =
        normalizeModelSelection(modelOverride) ??
        normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
        normalizeModelSelection(cfg.agents?.defaults?.subagents?.model);

      const resolvedThinkingDefaultRaw =
        readStringParam(targetAgentConfig?.subagents ?? {}, "thinking") ??
        readStringParam(cfg.agents?.defaults?.subagents ?? {}, "thinking");

      let thinkingOverride: string | undefined;
      const thinkingCandidateRaw = thinkingOverrideRaw || resolvedThinkingDefaultRaw;
      if (thinkingCandidateRaw) {
        const normalized = normalizeThinkLevel(thinkingCandidateRaw);
        if (!normalized) {
          const { provider, model } = splitModelRef(resolvedModel);
          const hint = formatThinkingLevels(provider, model);
          return jsonResult({
            status: "error",
            error: `Invalid thinking level "${thinkingCandidateRaw}". Use one of: ${hint}.`,
          });
        }
        thinkingOverride = normalized;
      }
      if (resolvedModel) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: { key: childSessionKey, model: resolvedModel },
            timeoutMs: 10_000,
          });
          modelApplied = true;
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          const recoverable =
            messageText.includes("invalid model") || messageText.includes("model not allowed");
          if (!recoverable) {
            emit({
              type: EVENT_TYPES.A2A_SPAWN_RESULT,
              agentId: requesterAgentId,
              ts: Date.now(),
              data: {
                fromAgent: requesterAgentId,
                toAgent: targetAgentId,
                targetSessionKey: childSessionKey,
                conversationId,
                parentConversationId,
                taskId,
                workSessionId,
                depth: depthValue,
                hop: hopValue,
                status: "error",
                error: messageText,
                replyPreview: `spawn failed: ${messageText}`.slice(0, 200),
              },
            });
            return jsonResult({
              status: "error",
              error: messageText,
              replyPreview: `spawn failed: ${messageText}`.slice(0, 200),
              childSessionKey,
              workSessionId,
              taskId,
              conversationId,
            });
          }
          modelWarning = messageText;
        }
      }
      if (thinkingOverride !== undefined) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: {
              key: childSessionKey,
              thinkingLevel: thinkingOverride === "off" ? null : thinkingOverride,
            },
            timeoutMs: 10_000,
          });
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          emit({
            type: EVENT_TYPES.A2A_SPAWN_RESULT,
            agentId: requesterAgentId,
            ts: Date.now(),
            data: {
              fromAgent: requesterAgentId,
              toAgent: targetAgentId,
              targetSessionKey: childSessionKey,
              conversationId,
              parentConversationId,
              taskId,
              workSessionId,
              depth: depthValue,
              hop: hopValue,
              status: "error",
              error: messageText,
              replyPreview: `spawn failed: ${messageText}`.slice(0, 200),
            },
          });
          return jsonResult({
            status: "error",
            error: messageText,
            replyPreview: `spawn failed: ${messageText}`.slice(0, 200),
            childSessionKey,
            workSessionId,
            taskId,
            conversationId,
          });
        }
      }
      const childSystemPrompt = buildSubagentSystemPrompt({
        requesterSessionKey,
        requesterOrigin,
        childSessionKey,
        label: label || undefined,
        task,
      });

      const childIdem = crypto.randomUUID();
      let childRunId: string = childIdem;
      try {
        const response = await callGateway<{ runId: string }>({
          method: "agent",
          params: {
            message: task,
            sessionKey: childSessionKey,
            channel: requesterOrigin?.channel,
            to: requesterOrigin?.to ?? undefined,
            accountId: requesterOrigin?.accountId ?? undefined,
            threadId:
              requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
            idempotencyKey: childIdem,
            deliver: false,
            lane: AGENT_LANE_SUBAGENT,
            extraSystemPrompt: childSystemPrompt,
            thinking: thinkingOverride,
            timeout: runTimeoutSeconds > 0 ? runTimeoutSeconds : undefined,
            label: label || undefined,
            spawnedBy: spawnedByKey,
            groupId: opts?.agentGroupId ?? undefined,
            groupChannel: opts?.agentGroupChannel ?? undefined,
            groupSpace: opts?.agentGroupSpace ?? undefined,
          },
          timeoutMs: 10_000,
        });
        if (typeof response?.runId === "string" && response.runId) {
          childRunId = response.runId;
        }
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        emit({
          type: EVENT_TYPES.A2A_SPAWN_RESULT,
          agentId: requesterAgentId,
          ts: Date.now(),
          data: {
            fromAgent: requesterAgentId,
            toAgent: targetAgentId,
            targetSessionKey: childSessionKey,
            conversationId,
            parentConversationId,
            taskId,
            workSessionId,
            depth: depthValue,
            hop: hopValue,
            runId: childRunId,
            status: "error",
            error: messageText,
            replyPreview: `spawn failed: ${messageText}`.slice(0, 200),
          },
        });
        return jsonResult({
          status: "error",
          error: messageText,
          childSessionKey,
          runId: childRunId,
          replyPreview: `spawn failed: ${messageText}`.slice(0, 200),
          workSessionId,
          taskId,
          conversationId,
        });
      }

      registerSubagentRun({
        runId: childRunId,
        childSessionKey,
        requesterSessionKey: requesterInternalKey,
        requesterOrigin,
        requesterDisplayKey,
        task,
        cleanup,
        label: label || undefined,
        conversationId,
        parentConversationId,
        taskId,
        workSessionId,
        depth: depthValue,
        hop: hopValue,
        requesterAgentId,
        targetAgentId,
        runTimeoutSeconds,
      });

      emit({
        type: EVENT_TYPES.A2A_SPAWN_RESULT,
        agentId: requesterAgentId,
        ts: Date.now(),
        data: {
          fromAgent: requesterAgentId,
          toAgent: targetAgentId,
          targetSessionKey: childSessionKey,
          conversationId,
          parentConversationId,
          taskId,
          workSessionId,
          depth: depthValue,
          hop: hopValue,
          runId: childRunId,
          status: "accepted",
          label: label || undefined,
          replyPreview: `spawn accepted · run ${childRunId}`.slice(0, 200),
        },
      });

      return jsonResult({
        status: "accepted",
        childSessionKey,
        runId: childRunId,
        conversationId,
        taskId,
        workSessionId,
        modelApplied: resolvedModel ? modelApplied : undefined,
        warning: modelWarning,
      });
    },
  };
}
