import crypto from "node:crypto";
import { formatThinkingLevels, normalizeThinkLevel } from "../auto-reply/thinking.js";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { emit } from "../infra/events/bus.js";
import { EVENT_TYPES } from "../infra/events/schemas.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "./agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { buildSubagentSystemPrompt } from "./subagent-announce.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { countActiveRunsForSession, registerSubagentRun } from "./subagent-registry.js";
import { readStringParam } from "./tools/common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./tools/sessions-helpers.js";
import { readCurrentTaskId, readTask } from "./tools/task-tool.js";

export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cleanup?: "delete" | "keep";
  expectsCompletionMessage?: boolean;
  taskId?: string;
  workSessionId?: string;
  parentConversationId?: string;
  depth?: number;
  hop?: number;
};

export type SpawnSubagentContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  requesterAgentIdOverride?: string;
};

export const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "auto-announces on completion, do not poll/sleep. The response will be sent back as a user message.";

export type SpawnSubagentResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  note?: string;
  modelApplied?: boolean;
  warning?: string;
  error?: string;
  conversationId?: string;
  taskId?: string;
  workSessionId?: string;
  replyPreview?: string;
};

export function splitModelRef(ref?: string) {
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

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
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
    if (!candidateTaskId) return undefined;
    try {
      const linkedTask = await readTask(workspaceDir, candidateTaskId);
      return normalizeOptionalString(linkedTask?.workSessionId);
    } catch {
      return undefined;
    }
  };
  const fromRequestedTask = await readTaskWorkSessionId(taskId);
  if (fromRequestedTask) return { workSessionId: fromRequestedTask, taskId };
  try {
    const currentTaskId = await readCurrentTaskId(workspaceDir);
    if (currentTaskId) {
      taskId = taskId ?? currentTaskId;
      const fromCurrentTask = await readTaskWorkSessionId(currentTaskId);
      if (fromCurrentTask) return { workSessionId: fromCurrentTask, taskId };
    }
  } catch {
    // ignore task context resolution errors
  }
  return { workSessionId: `ws_${crypto.randomUUID()}`, taskId };
}

export function normalizeModelSelection(value: unknown): string | undefined {
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

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const task = params.task;
  const label = params.label?.trim() || "";
  const requestedAgentId = params.agentId;
  const modelOverride = params.model;
  const thinkingOverrideRaw = params.thinking;
  const cleanup =
    params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
  const requesterOrigin = normalizeDeliveryContext({
    channel: ctx.agentChannel,
    accountId: ctx.agentAccountId,
    to: ctx.agentTo,
    threadId: ctx.agentThreadId,
  });
  const runTimeoutSeconds =
    typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.runTimeoutSeconds))
      : 0;
  let modelWarning: string | undefined;
  let modelApplied = false;

  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterSessionKey = ctx.agentSessionKey;
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
  const isRequesterSubagentSession =
    typeof ctx.agentSessionKey === "string" && isSubagentSessionKey(ctx.agentSessionKey);

  const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
  const maxSpawnDepth = cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 1;
  if (callerDepth >= maxSpawnDepth) {
    return {
      status: "forbidden",
      error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
    };
  }

  const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
  const activeChildren = countActiveRunsForSession(requesterInternalKey);
  if (activeChildren >= maxChildren) {
    return {
      status: "forbidden",
      error: `sessions_spawn has reached max active children for this session (${activeChildren}/${maxChildren})`,
    };
  }

  const requesterAgentId = normalizeAgentId(
    ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
  const targetAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : requesterAgentId;
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
      const allowedText = allowSet.size > 0 ? Array.from(allowSet).join(", ") : "none";
      return {
        status: "forbidden",
        error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
      };
    }
  }
  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
  const childDepth = callerDepth + 1;
  const { workSessionId, taskId } = await resolveSpawnWorkSessionContext({
    cfg,
    requesterAgentId,
    requestedTaskId: normalizeOptionalString(params.taskId),
    explicitWorkSessionId: normalizeOptionalString(params.workSessionId),
  });
  const parentConversationId = normalizeOptionalString(params.parentConversationId);
  const conversationId = parentConversationId ?? crypto.randomUUID();
  const depthValue =
    normalizeNonNegativeInt(params.depth) ?? (isRequesterSubagentSession ? callerDepth : 0);
  const hopValue = normalizeNonNegativeInt(params.hop) ?? 0;
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

  const spawnedByKey = requesterInternalKey;
  const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
  const runtimeDefaultModel = resolveDefaultModelForAgent({
    cfg,
    agentId: targetAgentId,
  });
  const resolvedModel =
    normalizeModelSelection(modelOverride) ??
    normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
    normalizeModelSelection(cfg.agents?.defaults?.subagents?.model) ??
    normalizeModelSelection(cfg.agents?.defaults?.model?.primary) ??
    normalizeModelSelection(`${runtimeDefaultModel.provider}/${runtimeDefaultModel.model}`);

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
      return {
        status: "error",
        error: `Invalid thinking level "${thinkingCandidateRaw}". Use one of: ${hint}.`,
      };
    }
    thinkingOverride = normalized;
  }
  try {
    await callGateway({
      method: "sessions.patch",
      params: { key: childSessionKey, spawnDepth: childDepth },
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
    return {
      status: "error",
      error: messageText,
      childSessionKey,
      conversationId,
      taskId,
      workSessionId,
      replyPreview: `spawn failed: ${messageText}`.slice(0, 200),
    };
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
    return {
      status: "error",
      error: messageText,
      childSessionKey,
      conversationId,
      taskId,
      workSessionId,
      replyPreview: `spawn failed: ${messageText}`.slice(0, 200),
    };
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
    return {
      status: "error",
      error: messageText,
      childSessionKey,
      conversationId,
      taskId,
      workSessionId,
      replyPreview: `spawn failed: ${messageText}`.slice(0, 200),
    };
    }
  }
  const childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey,
    requesterOrigin,
    childSessionKey,
    label: label || undefined,
    task,
    childDepth,
    maxSpawnDepth,
  });
  const childTaskMessage = [
    `[Subagent Context] You are running as a subagent (depth ${childDepth}/${maxSpawnDepth}). Results auto-announce to your requester; do not busy-poll for status.`,
    `[Subagent Task]: ${task}`,
  ].join("\n\n");

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
        threadId: requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
        idempotencyKey: childIdem,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: childSystemPrompt,
        thinking: thinkingOverride,
        timeout: runTimeoutSeconds,
        label: label || undefined,
        spawnedBy: spawnedByKey,
        groupId: ctx.agentGroupId ?? undefined,
        groupChannel: ctx.agentGroupChannel ?? undefined,
        groupSpace: ctx.agentGroupSpace ?? undefined,
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
        status: "error",
        error: messageText,
        replyPreview: `spawn failed: ${messageText}`.slice(0, 200),
        runId: childRunId,
      },
    });
    return {
      status: "error",
      error: messageText,
      childSessionKey,
      runId: childRunId,
      conversationId,
      taskId,
      workSessionId,
      replyPreview: `spawn failed: ${messageText}`.slice(0, 200),
    };
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
    model: resolvedModel,
    runTimeoutSeconds,
    expectsCompletionMessage: params.expectsCompletionMessage === true,
    conversationId,
    parentConversationId,
    taskId,
    workSessionId,
    depth: depthValue,
    hop: hopValue,
    requesterAgentId,
    targetAgentId,
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

  return {
    status: "accepted",
    childSessionKey,
    runId: childRunId,
    note: SUBAGENT_SPAWN_ACCEPTED_NOTE,
    modelApplied: resolvedModel ? modelApplied : undefined,
    warning: modelWarning,
    conversationId,
    taskId,
    workSessionId,
    replyPreview: `spawn accepted · run ${childRunId}`.slice(0, 200),
  };
}
