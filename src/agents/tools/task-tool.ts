// Re-exports (preserve external import paths)
export type {
  TaskStatus,
  TaskPriority,
  EscalationState,
  EstimatedEffort,
  TaskOutcome,
  TaskStepStatus,
  TaskStep,
  TaskFile,
} from "./task-file-io.js";

export {
  readTask,
  writeTask,
  findActiveTask,
  findPendingTasks,
  findPendingApprovalTasks,
  findBlockedTasks,
  findBacklogTasks,
  findAllBacklogTasks,
  checkDependenciesMet,
  findPickableBacklogTask,
  readCurrentTaskId,
  isAgentUsingTaskTools,
} from "./task-file-io.js";

export { checkStopGuard } from "./task-stop-guard.js";

export {
  createTaskStartTool,
  createTaskUpdateTool,
  createTaskCompleteTool,
  createTaskStatusTool,
  createTaskListTool,
  createTaskCancelTool,
} from "./task-crud.js";

export {
  createTaskBlockTool,
  createTaskResumeTool,
  createTaskApproveTool,
  createTaskBacklogAddTool,
  createTaskPickBacklogTool,
} from "./task-blocking.js";
