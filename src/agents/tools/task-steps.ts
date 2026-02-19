import type { TaskFile } from "./task-file-io.js";

export function summarizeStepCounts(task: TaskFile): {
  totalSteps: number;
  done: number;
  inProgress: number;
  pending: number;
  skipped: number;
} | undefined {
  if (!task.steps?.length) {
    return undefined;
  }

  return {
    totalSteps: task.steps.length,
    done: task.steps.filter((s) => s.status === "done").length,
    inProgress: task.steps.filter((s) => s.status === "in_progress").length,
    pending: task.steps.filter((s) => s.status === "pending").length,
    skipped: task.steps.filter((s) => s.status === "skipped").length,
  };
}
