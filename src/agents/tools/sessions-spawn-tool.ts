import { Type } from "@sinclair/typebox";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import { jsonResult, readStringParam } from "./common.js";
import { createDelegation } from "./task-delegation-manager.js";
import { appendDelegationToTask } from "./task-delegation-persistence.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("sessions-spawn-tool");

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  taskId: Type.Optional(Type.String()),
  workSessionId: Type.Optional(Type.String()),
  parentConversationId: Type.Optional(Type.String()),
  depth: Type.Optional(Type.Number({ minimum: 0 })),
  hop: Type.Optional(Type.Number({ minimum: 0 })),
});

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
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const taskIdParam =
        typeof params.taskId === "string" ? params.taskId.trim() || undefined : undefined;
      const explicitWorkSessionId =
        typeof params.workSessionId === "string"
          ? params.workSessionId.trim() || undefined
          : undefined;
      const parentConversationId =
        typeof params.parentConversationId === "string"
          ? params.parentConversationId.trim() || undefined
          : undefined;
      const depth =
        typeof params.depth === "number" && Number.isFinite(params.depth) && params.depth >= 0
          ? Math.floor(params.depth)
          : undefined;
      const hop =
        typeof params.hop === "number" && Number.isFinite(params.hop) && params.hop >= 0
          ? Math.floor(params.hop)
          : undefined;

      const result = await spawnSubagentDirect(
        {
          task,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          cleanup,
          expectsCompletionMessage: true,
          taskId: taskIdParam,
          workSessionId: explicitWorkSessionId,
          parentConversationId,
          depth,
          hop,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
        },
      );

      // Wire delegation into task file when taskId is present and spawn succeeded
      if (
        taskIdParam &&
        result.status === "accepted" &&
        typeof result.runId === "string" &&
        typeof result.childSessionKey === "string"
      ) {
        try {
          const cfg = loadConfig();
          const agentId = resolveSessionAgentId({ sessionKey: opts?.agentSessionKey, config: cfg });
          const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
          const requestedAgentIdNorm = requestedAgentId || "default";

          const { delegation, event } = createDelegation({
            taskId: taskIdParam,
            runId: result.runId,
            targetAgentId: requestedAgentIdNorm,
            targetSessionKey: result.childSessionKey,
            task,
            label: label || undefined,
          });

          const persisted = await appendDelegationToTask(
            workspaceDir,
            taskIdParam,
            delegation,
            event,
          );
          if (persisted) {
            log.info?.(
              `Delegation ${delegation.delegationId} created for task ${taskIdParam} → run ${result.runId}`,
            );
          }
        } catch (err) {
          // Best-effort: delegation tracking should not break spawn
          log.error?.(`Failed to create delegation for task ${taskIdParam}: ${String(err)}`);
        }
      }

      return jsonResult(result);
    },
  };
}
