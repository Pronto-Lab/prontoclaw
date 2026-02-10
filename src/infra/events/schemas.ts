export const EVENT_TYPES = {
  TASK_STARTED: "task.started",
  TASK_UPDATED: "task.updated",
  TASK_COMPLETED: "task.completed",
  TASK_CANCELLED: "task.cancelled",
  TASK_APPROVED: "task.approved",
  TASK_BLOCKED: "task.blocked",
  TASK_RESUMED: "task.resumed",
  TASK_BACKLOG_ADDED: "task.backlog_added",
  TASK_BACKLOG_PICKED: "task.backlog_picked",
  CONTINUATION_SENT: "continuation.sent",
  CONTINUATION_BACKOFF: "continuation.backoff",
  UNBLOCK_REQUESTED: "unblock.requested",
  UNBLOCK_FAILED: "unblock.failed",
  RESUME_REMINDER_SENT: "resume_reminder.sent",
  ZOMBIE_ABANDONED: "zombie.abandoned",
  BACKLOG_AUTO_PICKED: "backlog.auto_picked",
  PLAN_SUBMITTED: "plan.submitted",
  PLAN_APPROVED: "plan.approved",
  PLAN_REJECTED: "plan.rejected",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
