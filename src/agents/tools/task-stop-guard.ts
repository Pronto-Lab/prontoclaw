import type { TaskFile, TaskStepStatus } from "./task-file-io.js";

export interface StopGuardResult {
  blocked: boolean;
  reason?: string;
  incompleteSteps?: Array<{ id: string; content: string; status: TaskStepStatus }>;
}

/**
 * Pure function: check whether a task can be completed.
 * Returns { blocked: false } when task_complete may proceed,
 * or { blocked: true, reason, incompleteSteps } when it must be rejected.
 */
export function checkStopGuard(task: TaskFile): StopGuardResult {
  if (!task.steps?.length) {
    return { blocked: false };
  }

  const incomplete = task.steps.filter(
    (s) => s.status === "pending" || s.status === "in_progress",
  );

  if (incomplete.length === 0) {
    return { blocked: false };
  }

  return {
    blocked: true,
    reason: `Cannot complete task: ${incomplete.length} steps still incomplete`,
    incompleteSteps: incomplete.map((s) => ({
      id: s.id,
      content: s.content,
      status: s.status,
    })),
  };
}

/**
 * Format a human-readable error from a StopGuardResult.
 */
export function formatStopGuardError(result: StopGuardResult): string {
  if (!result.blocked) return "";
  const stepList = result.incompleteSteps
    ?.map((s) => `  - ${s.id}: ${s.content} (${s.status})`)
    .join("\n") ?? "";
  return `${result.reason}\n${stepList}`;
}
