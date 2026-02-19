/**
 * task_verify tool — Verify subagent delegation results.
 *
 * Allows the parent agent to accept, reject, or retry a subagent's
 * delegated work. Operates on delegation records stored in the task file.
 *
 * @see 11-subagent-task-lifecycle.md (Phase 4)
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  canRetry,
  computeDelegationSummary,
  findLatestCompletedDelegation,
  updateDelegation,
} from "./task-delegation-manager.js";
import {
  readTaskDelegations,
  updateDelegationInTask,
} from "./task-delegation-persistence.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TaskVerifySchema = Type.Object({
  taskId: Type.String({ description: "The task ID containing the delegation to verify." }),
  delegationId: Type.Optional(
    Type.String({
      description:
        "Specific delegation ID to verify. If omitted, the latest completed delegation is used.",
    }),
  ),
  action: optionalStringEnum(["accept", "reject", "retry"] as const),
  note: Type.Optional(
    Type.String({ description: "Optional verification note explaining the decision." }),
  ),
});

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createTaskVerifyTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  return {
    label: "Task Verify",
    name: "task_verify",
    description:
      "Verify a subagent delegation result. Use 'accept' to approve the result, 'reject' to deny it (with optional auto-retry), or 'retry' to explicitly re-run. Defaults to 'accept' if no action specified.",
    parameters: TaskVerifySchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const taskId = readStringParam(params, "taskId", { required: true });
      const delegationId = readStringParam(params, "delegationId");
      const action = (readStringParam(params, "action") || "accept") as string;
      const note = readStringParam(params, "note");

      // Read task + delegations
      const taskData = await readTaskDelegations(workspaceDir, taskId);
      if (!taskData) {
        return jsonResult({ error: `Task not found: ${taskId}` });
      }

      const { delegations } = taskData;
      if (delegations.length === 0) {
        return jsonResult({ error: "No delegations found for this task." });
      }

      // Find target delegation
      const target = delegationId
        ? delegations.find((d) => d.delegationId === delegationId)
        : findLatestCompletedDelegation(delegations);

      if (!target) {
        return jsonResult({
          error: delegationId
            ? `Delegation not found: ${delegationId}`
            : "No completed delegation found to verify.",
          delegations: delegations.map((d) => ({
            id: d.delegationId,
            status: d.status,
            task: d.task,
          })),
        });
      }

      // --- ACCEPT ---
      if (action === "accept") {
        if (target.status !== "completed") {
          return jsonResult({
            error: `Cannot accept delegation in '${target.status}' status. Only 'completed' delegations can be accepted.`,
          });
        }

        const result = updateDelegation(target, {
          status: "verified",
          verificationNote: note || undefined,
        });
        if (!result.ok) {
          return jsonResult({ error: result.error });
        }

        await updateDelegationInTask(workspaceDir, taskId, result.delegation, result.event);

        return jsonResult({
          status: "verified",
          delegationId: target.delegationId,
          message: "Delegation result accepted.",
          summary: computeDelegationSummary(
            delegations.map((d) => (d.delegationId === target.delegationId ? result.delegation : d)),
          ),
        });
      }

      // --- REJECT ---
      if (action === "reject") {
        if (target.status !== "completed") {
          return jsonResult({
            error: `Cannot reject delegation in '${target.status}' status. Only 'completed' delegations can be rejected.`,
          });
        }

        const result = updateDelegation(target, {
          status: "rejected",
          verificationNote: note || undefined,
        });
        if (!result.ok) {
          return jsonResult({ error: result.error });
        }

        await updateDelegationInTask(workspaceDir, taskId, result.delegation, result.event);

        const retriable = canRetry(result.delegation);
        return jsonResult({
          status: "rejected",
          delegationId: target.delegationId,
          canRetry: retriable,
          retryCount: result.delegation.retryCount,
          maxRetries: result.delegation.maxRetries,
          message: retriable
            ? "Delegation rejected. Use task_verify with action='retry' to re-run, or spawn a new subagent manually."
            : "Delegation rejected. No retries remaining — use task_verify with action='retry' on the rejected delegation to mark it abandoned, or handle manually.",
        });
      }

      // --- RETRY ---
      if (action === "retry") {
        // Retry from rejected or failed state
        if (target.status !== "rejected" && target.status !== "failed") {
          return jsonResult({
            error: `Cannot retry delegation in '${target.status}' status. Only 'rejected' or 'failed' delegations can be retried.`,
          });
        }

        if (!canRetry(target)) {
          // If can't retry, transition to abandoned
          const abandonResult = updateDelegation(target, {
            status: "abandoned",
            verificationNote: note || "Max retries exceeded",
          });
          if (!abandonResult.ok) {
            return jsonResult({ error: abandonResult.error });
          }

          await updateDelegationInTask(
            workspaceDir,
            taskId,
            abandonResult.delegation,
            abandonResult.event,
          );

          return jsonResult({
            status: "abandoned",
            delegationId: target.delegationId,
            message: `Delegation abandoned (${target.retryCount}/${target.maxRetries} retries exhausted).`,
          });
        }

        const retryResult = updateDelegation(target, {
          status: "retrying",
          verificationNote: note || undefined,
        });
        if (!retryResult.ok) {
          return jsonResult({ error: retryResult.error });
        }

        await updateDelegationInTask(
          workspaceDir,
          taskId,
          retryResult.delegation,
          retryResult.event,
        );

        return jsonResult({
          status: "retrying",
          delegationId: target.delegationId,
          retryCount: retryResult.delegation.retryCount,
          maxRetries: retryResult.delegation.maxRetries,
          previousErrors: retryResult.delegation.previousErrors,
          message:
            "Ready for retry. Call sessions_spawn with the same taskId to create a new subagent run.",
        });
      }

      return jsonResult({ error: `Unknown action: ${action}. Use 'accept', 'reject', or 'retry'.` });
    },
  };
}
