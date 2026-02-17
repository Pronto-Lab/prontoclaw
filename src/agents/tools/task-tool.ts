import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { emit } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import { retryAsync } from "../../infra/retry.js";
import { acquireTaskLock } from "../../infra/task-lock.js";
import { disableAgentManagedMode, enableAgentManagedMode } from "../../infra/task-tracker.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId, listAgentIds } from "../agent-scope.js";
import { jsonResult, readStringParam } from "./common.js";

const log = createSubsystemLogger("task-tool");

const TASKS_DIR = "tasks";
const TASK_HISTORY_DIR = "task-history";
const CURRENT_TASK_FILENAME = "CURRENT_TASK.md";

function getMonthlyHistoryFilename(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}.md`;
}

export type TaskStatus =
  | "pending"
  | "pending_approval"
  | "in_progress"
  | "blocked"
  | "backlog"
  | "completed"
  | "cancelled"
  | "abandoned"
  | "interrupted";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type EscalationState = "none" | "requesting" | "escalated" | "failed";
export type EstimatedEffort = "small" | "medium" | "large";

/** Discriminated union describing how a task ended. */
export type TaskOutcome =
  | { kind: "completed"; summary?: string }
  | { kind: "cancelled"; reason?: string; by?: string }
  | { kind: "error"; error: string; retriable?: boolean }
  | { kind: "interrupted"; by?: string; reason?: string };
export type TaskStepStatus = "pending" | "in_progress" | "done" | "skipped";

export interface TaskStep {
  id: string;
  content: string;
  status: TaskStepStatus;
  order: number;
}

export interface TaskFile {
  id: string;
  status: TaskStatus;
  priority: TaskPriority;
  description: string;
  context?: string;
  source?: string;
  created: string;
  lastActivity: string;
  workSessionId?: string;
  previousWorkSessionId?: string;
  progress: string[];
  // Blocked task fields for unblock request automation
  blockedReason?: string;
  unblockedBy?: string[];
  unblockedAction?: string;
  unblockRequestCount?: number;
  lastUnblockerIndex?: number;
  lastUnblockRequestAt?: string;
  escalationState?: EscalationState;
  unblockRequestFailures?: number;
  // Backlog task fields
  createdBy?: string; // Who added this task (user/agent id)
  assignee?: string; // Whose backlog (for cross-agent requests)
  dependsOn?: string[]; // Task IDs that must complete first
  estimatedEffort?: EstimatedEffort;
  startDate?: string; // ISO date - don't start before this date
  dueDate?: string; // ISO date - deadline
  // Milestone integration fields
  milestoneId?: string; // Linked milestone ID in Task Hub
  milestoneItemId?: string; // Linked milestone item ID in Task Hub
  reassignCount?: number; // Zombie recovery: number of times task was auto-reassigned
  steps?: TaskStep[];
  /** Terminal outcome when task reaches completed/cancelled/interrupted. */
  outcome?: TaskOutcome;
}

const TaskStartSchema = Type.Object({
  description: Type.String(),
  context: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String()),
  requires_approval: Type.Optional(Type.Boolean()),
});

const TaskUpdateSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
  progress: Type.Optional(Type.String()),
  action: Type.Optional(Type.String()),
  step_content: Type.Optional(Type.String()),
  step_id: Type.Optional(Type.String()),
  steps_order: Type.Optional(Type.Array(Type.String())),
  steps: Type.Optional(
    Type.Array(
      Type.Object({
        content: Type.String(),
        status: Type.Optional(Type.String()),
      }),
    ),
  ),
});

const TaskCompleteSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  force_complete: Type.Optional(Type.String()),
});

const TaskStatusSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
});

const TaskListSchema = Type.Object({
  status: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()),
});

const TaskCancelSchema = Type.Object({
  task_id: Type.String(),
  reason: Type.Optional(Type.String()),
});

const TaskApproveSchema = Type.Object({
  task_id: Type.String(),
});

const TaskBlockSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
  reason: Type.String(),
  unblock_by: Type.Array(Type.String()),
  unblock_action: Type.Optional(Type.String()),
});

const TaskResumeSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
});

const TaskBacklogAddSchema = Type.Object({
  description: Type.String(),
  context: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String()),
  estimated_effort: Type.Optional(Type.String()),
  start_date: Type.Optional(Type.String()),
  due_date: Type.Optional(Type.String()),
  depends_on: Type.Optional(Type.Array(Type.String())),
  assignee: Type.Optional(Type.String()),
  milestone_id: Type.Optional(Type.String()),
  milestone_item_id: Type.Optional(Type.String()),
});

const TaskPickBacklogSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
});

function generateTaskId(): string {
  return `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function generateWorkSessionId(): string {
  return `ws_${crypto.randomUUID()}`;
}

function normalizeWorkSessionId(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function ensureTaskWorkSessionId(task: TaskFile): string {
  const existing = normalizeWorkSessionId(task.workSessionId);
  if (existing) {
    task.workSessionId = existing;
    return existing;
  }
  const generated = generateWorkSessionId();
  task.workSessionId = generated;
  return generated;
}

const VALID_STATUSES = new Set<string>([
  "in_progress",
  "completed",
  "pending",
  "pending_approval",
  "blocked",
  "backlog",
  "cancelled",
  "abandoned",
  "interrupted",
]);
const VALID_PRIORITIES = new Set<string>(["low", "medium", "high", "urgent"]);

function isValidTaskStatus(s: string): s is TaskStatus {
  return VALID_STATUSES.has(s);
}

function isValidTaskPriority(p: string): p is TaskPriority {
  return VALID_PRIORITIES.has(p);
}

function formatTaskFileMd(task: TaskFile): string {
  const lines = [
    `# Task: ${task.id}`,
    "",
    "## Metadata",
    `- **Status:** ${task.status}`,
    `- **Priority:** ${task.priority}`,
    `- **Created:** ${task.created}`,
  ];

  if (task.source) {
    lines.push(`- **Source:** ${task.source}`);
  }
  if (task.workSessionId) {
    lines.push(`- **Work Session:** ${task.workSessionId}`);
  }
  if (task.previousWorkSessionId) {
    lines.push(`- **Previous Work Session:** ${task.previousWorkSessionId}`);
  }

  lines.push("", "## Description", task.description, "");

  if (task.context) {
    lines.push("## Context", task.context, "");
  }

  if (task.steps && task.steps.length > 0) {
    lines.push("## Steps");
    const sortedSteps = [...task.steps].toSorted((a, b) => a.order - b.order);
    for (const step of sortedSteps) {
      const marker =
        step.status === "done"
          ? "x"
          : step.status === "in_progress"
            ? ">"
            : step.status === "skipped"
              ? "-"
              : " ";
      lines.push(`- [${marker}] (${step.id}) ${step.content}`);
    }
    lines.push("");
  }

  lines.push("## Progress");
  for (const item of task.progress) {
    lines.push(`- ${item}`);
  }

  lines.push("", "## Last Activity", task.lastActivity, "");

  // Serialize blocking fields if present
  if (task.status === "blocked" || task.blockedReason || task.unblockedBy) {
    const blockingData = {
      blockedReason: task.blockedReason,
      unblockedBy: task.unblockedBy,
      unblockedAction: task.unblockedAction,
      unblockRequestCount: task.unblockRequestCount,
      lastUnblockerIndex: task.lastUnblockerIndex,
      lastUnblockRequestAt: task.lastUnblockRequestAt,
      escalationState: task.escalationState,
      unblockRequestFailures: task.unblockRequestFailures,
    };
    lines.push("## Blocking", "```json", JSON.stringify(blockingData), "```", "");
  }

  // Serialize backlog fields if present
  if (
    task.status === "backlog" ||
    task.createdBy ||
    task.assignee ||
    task.dependsOn ||
    task.startDate ||
    task.dueDate
  ) {
    const backlogData = {
      createdBy: task.createdBy,
      assignee: task.assignee,
      dependsOn: task.dependsOn,
      estimatedEffort: task.estimatedEffort,
      startDate: task.startDate,
      dueDate: task.dueDate,
      milestoneId: task.milestoneId,
      milestoneItemId: task.milestoneItemId,
      reassignCount: task.reassignCount,
    };
    lines.push("## Backlog", "```json", JSON.stringify(backlogData), "```", "");
  }

  // Serialize outcome if present
  if (task.outcome) {
    lines.push("## Outcome", "```json", JSON.stringify(task.outcome), "```", "");
  }

  lines.push("---", "*Managed by task tools*");

  return lines.join("\n");
}

function parseTaskFileMd(content: string, filename: string): TaskFile | null {
  if (!content || content.includes("*(No task)*")) {
    return null;
  }

  const idMatch = filename.match(/^(task_[a-z0-9_]+)\.md$/);
  const id = idMatch ? idMatch[1] : "";

  const lines = content.split("\n");
  let status: TaskStatus = "pending";
  let priority: TaskPriority = "medium";
  let description = "";
  let context: string | undefined;
  let source: string | undefined;
  let workSessionId: string | undefined;
  let previousWorkSessionId: string | undefined;
  let created = "";
  let lastActivity = "";
  const progress: string[] = [];
  const steps: TaskStep[] = [];
  let blockedReason: string | undefined;
  let unblockedBy: string[] | undefined;
  let unblockedAction: string | undefined;
  let unblockRequestCount: number | undefined;
  let lastUnblockerIndex: number | undefined;
  let lastUnblockRequestAt: string | undefined;
  let escalationState: EscalationState | undefined;
  let unblockRequestFailures: number | undefined;
  let createdBy: string | undefined;
  let assignee: string | undefined;
  let dependsOn: string[] | undefined;
  let estimatedEffort: EstimatedEffort | undefined;
  let startDate: string | undefined;
  let dueDate: string | undefined;
  let milestoneId: string | undefined;
  let milestoneItemId: string | undefined;
  let reassignCount: number | undefined;
  let outcome: TaskOutcome | undefined;

  let currentSection = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("## ")) {
      currentSection = trimmed.slice(3).toLowerCase();
      continue;
    }

    if (trimmed.startsWith("# Task:")) {
      continue;
    }

    if (trimmed.startsWith("---") || trimmed.startsWith("*Managed by")) {
      continue;
    }

    if (!trimmed) {
      continue;
    }

    if (currentSection === "metadata") {
      const statusMatch = trimmed.match(/^-?\s*\*\*Status:\*\*\s*(.+)$/);
      if (statusMatch) {
        const rawStatus = statusMatch[1];
        if (isValidTaskStatus(rawStatus)) {
          status = rawStatus;
        } else {
          return null;
        }
      }
      const priorityMatch = trimmed.match(/^-?\s*\*\*Priority:\*\*\s*(.+)$/);
      if (priorityMatch) {
        const rawPriority = priorityMatch[1];
        if (isValidTaskPriority(rawPriority)) {
          priority = rawPriority;
        }
      }
      const createdMatch = trimmed.match(/^-?\s*\*\*Created:\*\*\s*(.+)$/);
      if (createdMatch) {
        created = createdMatch[1];
      }
      const sourceMatch = trimmed.match(/^-?\s*\*\*Source:\*\*\s*(.+)$/);
      if (sourceMatch) {
        source = sourceMatch[1];
      }
      const workSessionMatch = trimmed.match(/^-?\s*\*\*Work Session:\*\*\s*(.+)$/);
      if (workSessionMatch) {
        workSessionId = normalizeWorkSessionId(workSessionMatch[1]);
      }
      const previousWorkSessionMatch = trimmed.match(
        /^-?\s*\*\*Previous Work Session:\*\*\s*(.+)$/,
      );
      if (previousWorkSessionMatch) {
        previousWorkSessionId = normalizeWorkSessionId(previousWorkSessionMatch[1]);
      }
    } else if (currentSection === "description") {
      description = description ? `${description}\n${trimmed}` : trimmed;
    } else if (currentSection === "context") {
      context = context ? `${context}\n${trimmed}` : trimmed;
    } else if (currentSection === "last activity") {
      lastActivity = trimmed;
    } else if (currentSection === "steps") {
      const stepMatch = trimmed.match(/^- \[([x> -])\] \((\w+)\) (.+)$/);
      if (stepMatch) {
        const [, marker, stepId, stepContent] = stepMatch;
        const stepStatus: TaskStepStatus =
          marker === "x"
            ? "done"
            : marker === ">"
              ? "in_progress"
              : marker === "-"
                ? "skipped"
                : "pending";
        steps.push({
          id: stepId,
          content: stepContent,
          status: stepStatus,
          order: steps.length + 1,
        });
      }
    } else if (currentSection === "progress") {
      if (trimmed.startsWith("- ")) {
        progress.push(trimmed.slice(2));
      }
    } else if (currentSection === "blocking") {
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const blockingData = JSON.parse(trimmed);
          blockedReason = blockingData.blockedReason;
          unblockedBy = blockingData.unblockedBy;
          unblockedAction = blockingData.unblockedAction;
          unblockRequestCount = blockingData.unblockRequestCount;
          lastUnblockerIndex = blockingData.lastUnblockerIndex;
          lastUnblockRequestAt = blockingData.lastUnblockRequestAt;
          escalationState = blockingData.escalationState;
          unblockRequestFailures = blockingData.unblockRequestFailures;
        } catch {
          // Ignore malformed JSON
        }
      }
    } else if (currentSection === "backlog") {
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const backlogData = JSON.parse(trimmed);
          createdBy = backlogData.createdBy;
          assignee = backlogData.assignee;
          dependsOn = backlogData.dependsOn;
          estimatedEffort = backlogData.estimatedEffort;
          startDate = backlogData.startDate;
          dueDate = backlogData.dueDate;
          milestoneId = backlogData.milestoneId;
          milestoneItemId = backlogData.milestoneItemId;
          if (typeof backlogData.reassignCount === "number") {
            reassignCount = backlogData.reassignCount;
          }
        } catch {
          // Ignore malformed JSON
        }
      }
    } else if (currentSection === "outcome") {
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const outcomeData = JSON.parse(trimmed);
          if (outcomeData.kind) {
            outcome = outcomeData as TaskOutcome;
          }
        } catch {
          // Ignore malformed JSON
        }
      }
    }
  }

  if (!description || !created) {
    return null;
  }

  return {
    id,
    status,
    priority,
    description,
    context,
    source,
    workSessionId,
    previousWorkSessionId,
    created,
    lastActivity: lastActivity || created,
    progress,
    steps: steps.length > 0 ? steps : undefined,
    blockedReason,
    unblockedBy,
    unblockedAction,
    unblockRequestCount,
    lastUnblockerIndex,
    lastUnblockRequestAt,
    escalationState,
    unblockRequestFailures,
    createdBy,
    assignee,
    dependsOn,
    estimatedEffort,
    startDate,
    dueDate,
    milestoneId,
    milestoneItemId,
    reassignCount,
    outcome,
  };
}

async function getTasksDir(workspaceDir: string): Promise<string> {
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  await fs.mkdir(tasksDir, { recursive: true });
  return tasksDir;
}

export async function readTask(workspaceDir: string, taskId: string): Promise<TaskFile | null> {
  if (!taskId || /[/\\]/.test(taskId)) {
    return null;
  }
  const tasksDir = await getTasksDir(workspaceDir);
  const filePath = path.resolve(tasksDir, `${taskId}.md`);
  if (!filePath.startsWith(path.resolve(tasksDir) + path.sep)) {
    return null;
  }
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return parseTaskFileMd(content, `${taskId}.md`);
  } catch {
    return null;
  }
}

let writeCounter = 0;

export async function writeTask(workspaceDir: string, task: TaskFile): Promise<void> {
  ensureTaskWorkSessionId(task);
  const tasksDir = await getTasksDir(workspaceDir);
  const filePath = path.join(tasksDir, `${task.id}.md`);
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${++writeCounter}`;
  const content = formatTaskFileMd(task);

  try {
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function deleteTask(workspaceDir: string, taskId: string): Promise<void> {
  if (!taskId || /[/\\]/.test(taskId)) {
    return;
  }
  const tasksDir = await getTasksDir(workspaceDir);
  const filePath = path.resolve(tasksDir, `${taskId}.md`);
  if (!filePath.startsWith(path.resolve(tasksDir) + path.sep)) {
    return;
  }
  try {
    await fs.unlink(filePath);
  } catch {
    // File doesn't exist, ignore
  }
}

async function listTasks(
  workspaceDir: string,
  statusFilter?: TaskStatus | "all",
): Promise<TaskFile[]> {
  const tasksDir = await getTasksDir(workspaceDir);
  const tasks: TaskFile[] = [];

  let files: string[] = [];
  try {
    files = await fs.readdir(tasksDir);
  } catch {
    return tasks;
  }

  for (const file of files) {
    if (!file.endsWith(".md") || !file.startsWith("task_")) {
      continue;
    }
    try {
      const filePath = path.join(tasksDir, file);
      const content = await fs.readFile(filePath, "utf-8");
      const task = parseTaskFileMd(content, file);
      if (task) {
        if (!statusFilter || statusFilter === "all" || task.status === statusFilter) {
          tasks.push(task);
        }
      }
    } catch {
      // File may have been deleted between readdir and readFile
    }
  }

  tasks.sort((a, b) => {
    const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    // For backlog tasks: due_date > start_date > created
    if (a.dueDate || b.dueDate) {
      const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      if (aDue !== bDue) {
        return aDue - bDue;
      }
    }

    if (a.startDate || b.startDate) {
      const aStart = a.startDate ? new Date(a.startDate).getTime() : Infinity;
      const bStart = b.startDate ? new Date(b.startDate).getTime() : Infinity;
      if (aStart !== bStart) {
        return aStart - bStart;
      }
    }

    return new Date(a.created).getTime() - new Date(b.created).getTime();
  });

  return tasks;
}

export async function findActiveTask(workspaceDir: string): Promise<TaskFile | null> {
  const tasks = await listTasks(workspaceDir, "in_progress");
  return tasks[0] || null;
}

export async function findPendingTasks(workspaceDir: string): Promise<TaskFile[]> {
  return listTasks(workspaceDir, "pending");
}

export async function findPendingApprovalTasks(workspaceDir: string): Promise<TaskFile[]> {
  return listTasks(workspaceDir, "pending_approval");
}

export async function findBlockedTasks(workspaceDir: string): Promise<TaskFile[]> {
  return listTasks(workspaceDir, "blocked");
}

export async function findBacklogTasks(workspaceDir: string): Promise<TaskFile[]> {
  const tasks = await listTasks(workspaceDir, "backlog");
  const now = new Date();
  return tasks.filter((t) => {
    if (t.startDate) {
      const startDate = new Date(t.startDate);
      if (startDate > now) {
        return false;
      }
    }
    return true;
  });
}

export async function findAllBacklogTasks(workspaceDir: string): Promise<TaskFile[]> {
  return listTasks(workspaceDir, "backlog");
}

export async function checkDependenciesMet(
  workspaceDir: string,
  task: TaskFile,
): Promise<{ met: boolean; unmetDeps: string[] }> {
  if (!task.dependsOn || task.dependsOn.length === 0) {
    return { met: true, unmetDeps: [] };
  }

  const unmetDeps: string[] = [];
  for (const depId of task.dependsOn) {
    const depTask = await readTask(workspaceDir, depId);
    if (!depTask) {
      // Task file deleted = completed/cancelled and archived to task-history
      continue;
    }
    if (depTask.status !== "completed") {
      unmetDeps.push(depId);
    }
  }

  return { met: unmetDeps.length === 0, unmetDeps };
}

export async function findPickableBacklogTask(workspaceDir: string): Promise<TaskFile | null> {
  const backlogTasks = await findBacklogTasks(workspaceDir);

  for (const task of backlogTasks) {
    const { met } = await checkDependenciesMet(workspaceDir, task);
    if (met) {
      return task;
    }
  }

  return null;
}

async function appendToHistory(workspaceDir: string, entry: string): Promise<string> {
  const historyDir = path.join(workspaceDir, TASK_HISTORY_DIR);
  await fs.mkdir(historyDir, { recursive: true });

  const filename = getMonthlyHistoryFilename();
  const filePath = path.join(historyDir, filename);

  let lock: Awaited<ReturnType<typeof acquireTaskLock>> = null;
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    lock = await acquireTaskLock(workspaceDir, `history_${filename}`);
    if (lock) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50 * Math.pow(2, attempt)));
  }
  if (!lock) {
    throw new Error(`Failed to acquire history lock after ${maxRetries} retries`);
  }

  try {
    return await appendToHistoryLocked(filePath, filename, entry);
  } finally {
    await lock.release();
  }
}

async function appendToHistoryLocked(
  filePath: string,
  filename: string,
  entry: string,
): Promise<string> {
  let needsHeader = false;
  try {
    await fs.access(filePath);
  } catch {
    needsHeader = true;
  }

  if (needsHeader) {
    const now = new Date();
    const monthName = now.toLocaleString("en-US", { month: "long", year: "numeric" });
    const header = `# Task History - ${monthName}\n`;
    await fs.appendFile(filePath, header, "utf-8");
  }

  await fs.appendFile(filePath, entry, "utf-8");
  return `${TASK_HISTORY_DIR}/${filename}`;
}

function formatTaskHistoryEntry(task: TaskFile, summary?: string): string {
  const completed = new Date().toISOString();
  const started = new Date(task.created);
  const completedDate = new Date(completed);
  const durationMs = completedDate.getTime() - started.getTime();
  const durationMins = Math.round(durationMs / 60000);
  const durationStr =
    durationMins >= 60
      ? `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`
      : `${durationMins}m`;

  const lines = ["", "---", "", `## [${completed}] ${task.description}`, ""];

  if (task.context) {
    lines.push(`**Context:** ${task.context}`);
  }

  lines.push(
    `**Task ID:** ${task.id}`,
    `**Priority:** ${task.priority}`,
    `**Started:** ${task.created}`,
    `**Completed:** ${completed}`,
    `**Duration:** ${durationStr}`,
    "",
    "### Progress",
  );

  for (const item of task.progress) {
    lines.push(`- ${item}`);
  }

  if (summary) {
    lines.push("", "### Summary", summary);
  }

  return lines.join("\n");
}

async function updateCurrentTaskPointer(
  workspaceDir: string,
  taskId: string | null,
): Promise<void> {
  const filePath = path.join(workspaceDir, CURRENT_TASK_FILENAME);
  await fs.mkdir(workspaceDir, { recursive: true });

  if (!taskId) {
    const content = [
      "# Current Task",
      "",
      "*(No active focus task)*",
      "",
      "Use `task_list` to see all tasks.",
      "",
      "---",
      "*Managed by task tools*",
    ].join("\n");
    await fs.writeFile(filePath, content, "utf-8");
    return;
  }

  const task = await readTask(workspaceDir, taskId);
  if (!task) {
    return;
  }

  const content = [
    "# Current Task",
    "",
    `**Focus:** ${task.id}`,
    "",
    `## ${task.description}`,
    "",
    `**Status:** ${task.status}`,
    `**Priority:** ${task.priority}`,
    `**Created:** ${task.created}`,
    "",
    "### Progress",
    ...task.progress.map((p) => `- ${p}`),
    "",
    "---",
    "*Managed by task tools*",
  ].join("\n");

  await fs.writeFile(filePath, content, "utf-8");
}

export async function readCurrentTaskId(workspaceDir: string): Promise<string | null> {
  const filePath = path.join(workspaceDir, CURRENT_TASK_FILENAME);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const match = content.match(/^\*\*Focus:\*\*\s+(task_[a-z0-9_]+)\s*$/im);
    if (!match) {
      return null;
    }
    return match[1];
  } catch {
    return null;
  }
}

async function hasActiveTasks(workspaceDir: string): Promise<boolean> {
  const tasks = await listTasks(workspaceDir);
  return tasks.some(
    (t) => t.status === "in_progress" || t.status === "pending" || t.status === "pending_approval",
  );
}

export async function isAgentUsingTaskTools(workspaceDir: string): Promise<boolean> {
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  try {
    const files = await fs.readdir(tasksDir);
    return files.some((f) => f.startsWith("task_") && f.endsWith(".md"));
  } catch {
    return false;
  }
}

export function createTaskStartTool(options: {
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
    label: "Task Start",
    name: "task_start",
    description:
      "Start a new task. Creates a task file in tasks/ directory. Multiple tasks can exist simultaneously. If requires_approval is true, task starts in pending_approval status and needs task_approve before work begins. Returns the task_id for future reference.",
    parameters: TaskStartSchema,
    execute: async (_toolCallId, params) => {
      const description = readStringParam(params, "description", { required: true });
      const context = readStringParam(params, "context");
      const priorityRaw = readStringParam(params, "priority") || "medium";
      const priority = ["low", "medium", "high", "urgent"].includes(priorityRaw)
        ? (priorityRaw as TaskPriority)
        : "medium";
      const requiresApproval = (params as Record<string, unknown>).requires_approval === true;

      const now = new Date().toISOString();
      const taskId = generateTaskId();

      const initialStatus: TaskStatus = requiresApproval ? "pending_approval" : "in_progress";
      const initialProgress = requiresApproval
        ? "Task created - awaiting approval"
        : "Task started";
      const workSessionId = generateWorkSessionId();

      const newTask: TaskFile = {
        id: taskId,
        status: initialStatus,
        priority,
        description,
        context,
        source: "user",
        created: now,
        lastActivity: now,
        workSessionId,
        progress: [initialProgress],
      };

      await writeTask(workspaceDir, newTask);
      emit({
        type: EVENT_TYPES.TASK_STARTED,
        agentId,
        ts: Date.now(),
        data: { taskId, priority, requiresApproval, workSessionId },
      });
      await updateCurrentTaskPointer(workspaceDir, taskId);

      if (!requiresApproval) {
        enableAgentManagedMode(agentId);
      }

      const allTasks = await listTasks(workspaceDir);

      return jsonResult({
        success: true,
        taskId,
        status: initialStatus,
        requiresApproval,
        started: requiresApproval ? null : now,
        createdAt: now,
        priority,
        workSessionId,
        totalActiveTasks: allTasks.length,
      });
    },
  };
}

export function createTaskUpdateTool(options: {
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
    label: "Task Update",
    name: "task_update",
    description:
      "Update a task's progress or manage steps. If task_id is omitted, updates the most recent in_progress task. Use 'progress' for free-form logs. Use 'action' for step management: set_steps, add_step, complete_step, start_step, skip_step, reorder_steps.",
    parameters: TaskUpdateSchema,
    execute: async (_toolCallId, params) => {
      const taskIdParam = readStringParam(params, "task_id");
      const progress = readStringParam(params, "progress");
      const action = readStringParam(params, "action");
      const stepContent = readStringParam(params, "step_content");
      const stepId = readStringParam(params, "step_id");
      const rawStepsOrder = (params as Record<string, unknown>).steps_order;
      const stepsOrder = Array.isArray(rawStepsOrder)
        ? rawStepsOrder.filter((s): s is string => typeof s === "string")
        : undefined;
      const rawSteps = (params as Record<string, unknown>).steps;
      const stepsInput = Array.isArray(rawSteps)
        ? (rawSteps as Array<{ content: string; status?: string }>)
        : undefined;

      if (!progress && !action) {
        return jsonResult({
          success: false,
          error: "Either progress or action is required",
        });
      }

      let task: TaskFile | null = null;

      if (taskIdParam) {
        task = await readTask(workspaceDir, taskIdParam);
        if (!task) {
          return jsonResult({
            success: false,
            error: `Task not found: ${taskIdParam}`,
          });
        }
      } else {
        task = await findActiveTask(workspaceDir);
        if (!task) {
          return jsonResult({
            success: false,
            error: "No active task. Use task_start first or specify task_id.",
          });
        }
      }

      const lock = await acquireTaskLock(workspaceDir, task.id);
      if (!lock) {
        return jsonResult({
          success: false,
          error: `Task ${task.id} is locked by another operation`,
        });
      }

      try {
        const freshTask = await readTask(workspaceDir, task.id);
        if (!freshTask) {
          return jsonResult({
            success: false,
            error: `Task ${task.id} was deleted during lock acquisition`,
          });
        }

        const now = new Date().toISOString();
        freshTask.lastActivity = now;

        if (progress) {
          freshTask.progress.push(progress);
        }

        if (action) {
          if (!freshTask.steps) {
            freshTask.steps = [];
          }

          switch (action) {
            case "set_steps": {
              if (!stepsInput || stepsInput.length === 0) {
                return jsonResult({
                  success: false,
                  error: "set_steps requires a non-empty steps array",
                });
              }
              freshTask.steps = stepsInput.map((s, i) => ({
                id: `s${i + 1}`,
                content: s.content,
                status: (s.status === "done" || s.status === "in_progress" || s.status === "skipped"
                  ? s.status
                  : "pending") as TaskStepStatus,
                order: i + 1,
              }));
              const firstPending = freshTask.steps.find((s) => s.status === "pending");
              if (firstPending) {
                firstPending.status = "in_progress";
              }
              freshTask.progress.push(`Steps set: ${freshTask.steps.length} steps defined`);
              break;
            }
            case "add_step": {
              if (!stepContent) {
                return jsonResult({ success: false, error: "add_step requires step_content" });
              }
              const existingNums = freshTask.steps.map((s) => {
                const m = s.id.match(/^s(\d+)$/);
                return m ? parseInt(m[1], 10) : 0;
              });
              const maxNum = existingNums.length > 0 ? Math.max(...existingNums) : 0;
              const nextId = `s${maxNum + 1}`;
              const nextOrder =
                freshTask.steps.length > 0
                  ? Math.max(...freshTask.steps.map((s) => s.order)) + 1
                  : 1;
              freshTask.steps.push({
                id: nextId,
                content: stepContent,
                status: "pending",
                order: nextOrder,
              });
              freshTask.progress.push(`Step added: (${nextId}) ${stepContent}`);
              break;
            }
            case "complete_step": {
              if (!stepId) {
                return jsonResult({ success: false, error: "complete_step requires step_id" });
              }
              const step = freshTask.steps.find((s) => s.id === stepId);
              if (!step) {
                return jsonResult({ success: false, error: `Step not found: ${stepId}` });
              }
              step.status = "done";
              freshTask.progress.push(`[${stepId}] ${step.content} — completed`);
              const sortedSteps = [...freshTask.steps].toSorted((a, b) => a.order - b.order);
              const nextPending = sortedSteps.find((s) => s.status === "pending");
              if (nextPending) {
                nextPending.status = "in_progress";
              }
              break;
            }
            case "start_step": {
              if (!stepId) {
                return jsonResult({ success: false, error: "start_step requires step_id" });
              }
              const targetStep = freshTask.steps.find((s) => s.id === stepId);
              if (!targetStep) {
                return jsonResult({ success: false, error: `Step not found: ${stepId}` });
              }
              for (const s of freshTask.steps) {
                if (s.status === "in_progress") {
                  s.status = "pending";
                }
              }
              targetStep.status = "in_progress";
              freshTask.progress.push(`[${stepId}] ${targetStep.content} — started`);
              break;
            }
            case "skip_step": {
              if (!stepId) {
                return jsonResult({ success: false, error: "skip_step requires step_id" });
              }
              const skipStep = freshTask.steps.find((s) => s.id === stepId);
              if (!skipStep) {
                return jsonResult({ success: false, error: `Step not found: ${stepId}` });
              }
              skipStep.status = "skipped";
              freshTask.progress.push(`[${stepId}] ${skipStep.content} — skipped`);
              const sortedForSkip = [...freshTask.steps].toSorted((a, b) => a.order - b.order);
              const hasInProgress = sortedForSkip.some((s) => s.status === "in_progress");
              if (!hasInProgress) {
                const nextPendingAfterSkip = sortedForSkip.find((s) => s.status === "pending");
                if (nextPendingAfterSkip) {
                  nextPendingAfterSkip.status = "in_progress";
                }
              }
              break;
            }
            case "reorder_steps": {
              if (!stepsOrder || stepsOrder.length === 0) {
                return jsonResult({
                  success: false,
                  error: "reorder_steps requires steps_order array",
                });
              }
              const stepMap = new Map(freshTask.steps.map((s) => [s.id, s]));
              let order = 1;
              for (const sid of stepsOrder) {
                const s = stepMap.get(sid);
                if (s) {
                  s.order = order++;
                }
              }
              for (const s of freshTask.steps) {
                if (!stepsOrder.includes(s.id)) {
                  s.order = order++;
                }
              }
              freshTask.progress.push(`Steps reordered: ${stepsOrder.join(", ")}`);
              break;
            }
            default:
              return jsonResult({
                success: false,
                error: `Unknown action: ${action}. Valid: set_steps, add_step, complete_step, start_step, skip_step, reorder_steps`,
              });
          }
        }

        await writeTask(workspaceDir, freshTask);
        emit({
          type: EVENT_TYPES.TASK_UPDATED,
          agentId,
          ts: Date.now(),
          data: {
            taskId: freshTask.id,
            progressCount: freshTask.progress.length,
            workSessionId: freshTask.workSessionId,
          },
        });
        await updateCurrentTaskPointer(workspaceDir, freshTask.id);

        const stepsInfo = freshTask.steps?.length
          ? {
              totalSteps: freshTask.steps.length,
              done: freshTask.steps.filter((s) => s.status === "done").length,
              inProgress: freshTask.steps.filter((s) => s.status === "in_progress").length,
              pending: freshTask.steps.filter((s) => s.status === "pending").length,
              skipped: freshTask.steps.filter((s) => s.status === "skipped").length,
            }
          : undefined;

        return jsonResult({
          success: true,
          taskId: freshTask.id,
          updated: now,
          progressCount: freshTask.progress.length,
          workSessionId: freshTask.workSessionId,
          steps: stepsInfo,
        });
      } finally {
        await lock.release();
      }
    },
  };
}

export function createTaskCompleteTool(options: {
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
    label: "Task Complete",
    name: "task_complete",
    description:
      "Mark a task as complete. If task_id is omitted, completes the most recent in_progress task. Archives the task to TASK_HISTORY.md and removes the task file.",
    parameters: TaskCompleteSchema,
    execute: async (_toolCallId, params) => {
      const taskIdParam = readStringParam(params, "task_id");
      const summary = readStringParam(params, "summary");

      let task: TaskFile | null = null;

      if (taskIdParam) {
        task = await readTask(workspaceDir, taskIdParam);
        if (!task) {
          return jsonResult({
            success: false,
            error: `Task not found: ${taskIdParam}`,
          });
        }
      } else {
        task = await findActiveTask(workspaceDir);
        if (!task) {
          return jsonResult({
            success: false,
            error: "No active task to complete.",
          });
        }
      }

      const lock = await acquireTaskLock(workspaceDir, task.id);
      if (!lock) {
        return jsonResult({
          success: false,
          error: `Task ${task.id} is locked by another operation`,
        });
      }

      try {
        const freshTask = await readTask(workspaceDir, task.id);
        if (!freshTask) {
          return jsonResult({
            success: false,
            error: `Task ${task.id} was deleted during lock acquisition`,
          });
        }

        // ─── STOP GUARD ───
        if (freshTask.steps?.length) {
          const incomplete = freshTask.steps.filter(
            (s) => s.status === "pending" || s.status === "in_progress",
          );

          if (incomplete.length > 0) {
            const forceComplete = readStringParam(params, "force_complete");

            if (forceComplete !== "true") {
              freshTask.progress.push(
                `Stop Guard: task_complete blocked — ${incomplete.length} steps remaining`,
              );
              freshTask.lastActivity = new Date().toISOString();
              await writeTask(workspaceDir, freshTask);

              return jsonResult({
                success: false,
                blocked_by: "stop_guard",
                error: `Cannot complete task: ${incomplete.length} steps still incomplete`,
                remaining_steps: incomplete.map((s) => ({
                  id: s.id,
                  content: s.content,
                  status: s.status,
                })),
                instructions: [
                  "Complete remaining steps: task_update(action: 'complete_step', step_id: '...')",
                  "Or skip them: task_update(action: 'skip_step', step_id: '...')",
                  "Or force complete: task_complete(force_complete: 'true')",
                ],
              });
            } else {
              freshTask.progress.push(
                `Force completed with ${incomplete.length} steps remaining: ${incomplete.map((s) => s.id).join(", ")}`,
              );
            }
          }
        }
        // ─── END STOP GUARD ───

        freshTask.progress.push("Task completed");
        freshTask.status = "completed";
        freshTask.outcome = { kind: "completed", summary };

        const historyEntry = formatTaskHistoryEntry(freshTask, summary);

        await writeTask(workspaceDir, freshTask);
        emit({
          type: EVENT_TYPES.TASK_COMPLETED,
          agentId,
          ts: Date.now(),
          data: { taskId: freshTask.id, workSessionId: freshTask.workSessionId },
        });

        const archivedTo = await appendToHistory(workspaceDir, historyEntry);

        await deleteTask(workspaceDir, freshTask.id);

        const remainingTasks = await listTasks(workspaceDir);
        const nextTask = remainingTasks.find((t) => t.status === "in_progress") || null;

        await updateCurrentTaskPointer(workspaceDir, nextTask?.id || null);

        if (!(await hasActiveTasks(workspaceDir))) {
          disableAgentManagedMode(agentId);
        }

        if (freshTask.milestoneId && freshTask.milestoneItemId) {
          const hubUrl = process.env.TASK_HUB_URL || "http://localhost:3102";
          try {
            await retryAsync(
              async () => {
                const resp = await fetch(
                  `${hubUrl}/api/milestones/${freshTask.milestoneId}/items/${freshTask.milestoneItemId}`,
                  {
                    method: "PUT",
                    headers: {
                      "Content-Type": "application/json",
                      Cookie: "task-hub-session=authenticated",
                    },
                    body: JSON.stringify({ status: "done" }),
                  },
                );
                if (!resp.ok) {
                  throw new Error(`Milestone sync HTTP ${resp.status}`);
                }
              },
              { attempts: 3, minDelayMs: 500, maxDelayMs: 5000, label: "milestone-sync" },
            );
          } catch (err) {
            log.warn("Milestone sync failed after retries", {
              taskId: freshTask.id,
              milestoneId: freshTask.milestoneId,
              error: String(err),
            });
            emit({
              type: EVENT_TYPES.MILESTONE_SYNC_FAILED,
              agentId,
              ts: Date.now(),
              data: {
                taskId: freshTask.id,
                milestoneId: freshTask.milestoneId,
                workSessionId: freshTask.workSessionId,
              },
            });
          }
        }

        return jsonResult({
          success: true,
          taskId: freshTask.id,
          archived: true,
          archivedTo,
          completedAt: new Date().toISOString(),
          workSessionId: freshTask.workSessionId,
          remainingTasks: remainingTasks.length,
          nextTaskId: nextTask?.id || null,
        });
      } finally {
        await lock.release();
      }
    },
  };
}

export function createTaskStatusTool(options: {
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
    label: "Task Status",
    name: "task_status",
    description:
      "Get task status. If task_id is provided, returns that specific task. Otherwise returns a summary of all active tasks.",
    parameters: TaskStatusSchema,
    execute: async (_toolCallId, params) => {
      const taskIdParam = readStringParam(params, "task_id");

      if (taskIdParam) {
        const task = await readTask(workspaceDir, taskIdParam);
        if (!task) {
          return jsonResult({
            found: false,
            error: `Task not found: ${taskIdParam}`,
          });
        }
        const stepsInfo = task.steps?.length
          ? {
              steps: [...task.steps]
                .toSorted((a, b) => a.order - b.order)
                .map((s) => ({
                  id: s.id,
                  content: s.content,
                  status: s.status,
                })),
              totalSteps: task.steps.length,
              done: task.steps.filter((s) => s.status === "done").length,
              inProgress: task.steps.filter((s) => s.status === "in_progress").length,
              pending: task.steps.filter((s) => s.status === "pending").length,
              skipped: task.steps.filter((s) => s.status === "skipped").length,
            }
          : undefined;

        return jsonResult({
          found: true,
          task: {
            id: task.id,
            status: task.status,
            priority: task.priority,
            description: task.description,
            context: task.context,
            created: task.created,
            lastActivity: task.lastActivity,
            workSessionId: task.workSessionId,
            progressCount: task.progress.length,
            latestProgress: task.progress[task.progress.length - 1],
            ...(stepsInfo ? stepsInfo : {}),
          },
        });
      }

      const allTasks = await listTasks(workspaceDir);
      const activeTask = await findActiveTask(workspaceDir);

      return jsonResult({
        totalTasks: allTasks.length,
        byStatus: {
          in_progress: allTasks.filter((t) => t.status === "in_progress").length,
          pending: allTasks.filter((t) => t.status === "pending").length,
          pending_approval: allTasks.filter((t) => t.status === "pending_approval").length,
          blocked: allTasks.filter((t) => t.status === "blocked").length,
        },
        currentFocus: activeTask
          ? {
              id: activeTask.id,
              description: activeTask.description,
              priority: activeTask.priority,
              workSessionId: activeTask.workSessionId,
            }
          : null,
        tasks: allTasks.map((t) => ({
          id: t.id,
          status: t.status,
          priority: t.priority,
          description: t.description.slice(0, 50) + (t.description.length > 50 ? "..." : ""),
          workSessionId: t.workSessionId,
        })),
      });
    },
  };
}

export function createTaskListTool(options: {
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
    label: "Task List",
    name: "task_list",
    description:
      "List all tasks. Optionally filter by status: 'all', 'pending', 'pending_approval', 'in_progress', 'blocked', 'backlog'. Use scope='all' to aggregate tasks from ALL agents. Returns tasks sorted by priority then creation time.",
    parameters: TaskListSchema,
    execute: async (_toolCallId, params) => {
      const statusParam = readStringParam(params, "status") || "all";
      const scopeParam = readStringParam(params, "scope");
      const statusFilter = [
        "all",
        "pending",
        "pending_approval",
        "in_progress",
        "blocked",
        "backlog",
      ].includes(statusParam)
        ? (statusParam as TaskStatus | "all")
        : "all";

      // M7: scope='all' aggregates tasks from all agents
      if (scopeParam === "all" && cfg) {
        const allAgentIds = listAgentIds(cfg);
        const aggregated: Array<{
          agentId: string;
          id: string;
          status: string;
          priority: string;
          description: string;
          created: string;
          lastActivity: string;
          workSessionId?: string;
          progressCount: number;
          stepsTotal?: number;
          stepsDone?: number;
        }> = [];
        for (const aid of allAgentIds) {
          const ws = resolveAgentWorkspaceDir(cfg, aid);
          const agentTasks = await listTasks(ws, statusFilter);
          for (const t of agentTasks) {
            aggregated.push({
              agentId: aid,
              id: t.id,
              status: t.status,
              priority: t.priority,
              description: t.description,
              created: t.created,
              lastActivity: t.lastActivity,
              workSessionId: t.workSessionId,
              progressCount: t.progress.length,
              ...(t.steps?.length
                ? {
                    stepsTotal: t.steps.length,
                    stepsDone: t.steps.filter((s) => s.status === "done").length,
                  }
                : {}),
            });
          }
        }
        return jsonResult({
          filter: statusFilter,
          scope: "all",
          count: aggregated.length,
          tasks: aggregated,
        });
      }

      const tasks = await listTasks(workspaceDir, statusFilter);

      return jsonResult({
        filter: statusFilter,
        count: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          status: t.status,
          priority: t.priority,
          description: t.description,
          created: t.created,
          lastActivity: t.lastActivity,
          workSessionId: t.workSessionId,
          progressCount: t.progress.length,
          ...(t.steps?.length
            ? {
                stepsTotal: t.steps.length,
                stepsDone: t.steps.filter((s) => s.status === "done").length,
              }
            : {}),
        })),
      });
    },
  };
}

export function createTaskCancelTool(options: {
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
    label: "Task Cancel",
    name: "task_cancel",
    description:
      "Cancel a task without completing it. The task is archived to history with cancelled status and removed from active tasks.",
    parameters: TaskCancelSchema,
    execute: async (_toolCallId, params) => {
      const taskId = readStringParam(params, "task_id", { required: true });
      const reason = readStringParam(params, "reason");

      const task = await readTask(workspaceDir, taskId);
      if (!task) {
        return jsonResult({
          success: false,
          error: `Task not found: ${taskId}`,
        });
      }

      const lock = await acquireTaskLock(workspaceDir, task.id);
      if (!lock) {
        return jsonResult({
          success: false,
          error: `Task ${task.id} is locked by another operation`,
        });
      }

      try {
        task.status = "cancelled";
        task.outcome = { kind: "cancelled", reason };
        task.progress.push(`Task cancelled${reason ? `: ${reason}` : ""}`);

        await writeTask(workspaceDir, task);
        emit({
          type: EVENT_TYPES.TASK_CANCELLED,
          agentId,
          ts: Date.now(),
          data: { taskId: task.id, reason, workSessionId: task.workSessionId },
        });

        const historyEntry = formatTaskHistoryEntry(
          task,
          reason ? `Cancelled: ${reason}` : "Cancelled",
        );
        await appendToHistory(workspaceDir, historyEntry);

        await deleteTask(workspaceDir, task.id);

        const remainingTasks = await listTasks(workspaceDir);
        const nextTask = remainingTasks.find((t) => t.status === "in_progress") || null;

        await updateCurrentTaskPointer(workspaceDir, nextTask?.id || null);

        if (!(await hasActiveTasks(workspaceDir))) {
          disableAgentManagedMode(agentId);
        }

        // Reverse-sync: update milestone item to "done" if linked
        if (task.milestoneId && task.milestoneItemId) {
          const hubUrl = process.env.TASK_HUB_URL || "http://localhost:3102";
          try {
            await retryAsync(
              async () => {
                const resp = await fetch(
                  `${hubUrl}/api/milestones/${task.milestoneId}/items/${task.milestoneItemId}`,
                  {
                    method: "PUT",
                    headers: {
                      "Content-Type": "application/json",
                      Cookie: "task-hub-session=authenticated",
                    },
                    body: JSON.stringify({ status: "done" }),
                  },
                );
                if (!resp.ok) {
                  throw new Error(`Milestone sync HTTP ${resp.status}`);
                }
              },
              { attempts: 3, minDelayMs: 500, maxDelayMs: 5000, label: "milestone-sync" },
            );
          } catch (err) {
            log.warn("Milestone sync failed after retries", {
              taskId: task.id,
              milestoneId: task.milestoneId,
              error: String(err),
            });
            emit({
              type: EVENT_TYPES.MILESTONE_SYNC_FAILED,
              agentId,
              ts: Date.now(),
              data: {
                taskId: task.id,
                milestoneId: task.milestoneId,
                workSessionId: task.workSessionId,
              },
            });
          }
        }

        return jsonResult({
          success: true,
          taskId: task.id,
          cancelled: true,
          reason: reason || null,
          workSessionId: task.workSessionId,
          remainingTasks: remainingTasks.length,
        });
      } finally {
        await lock.release();
      }
    },
  };
}

export function createTaskApproveTool(options: {
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
    label: "Task Approve",
    name: "task_approve",
    description:
      "Approve a task that is waiting for approval. Transitions task from pending_approval to in_progress status.",
    parameters: TaskApproveSchema,
    execute: async (_toolCallId, params) => {
      const taskId = readStringParam(params, "task_id", { required: true });

      const task = await readTask(workspaceDir, taskId);
      if (!task) {
        return jsonResult({
          success: false,
          error: `Task not found: ${taskId}`,
        });
      }

      if (task.status !== "pending_approval") {
        return jsonResult({
          success: false,
          error: `Task ${taskId} is not pending approval. Current status: ${task.status}`,
        });
      }

      const now = new Date().toISOString();
      task.status = "in_progress";
      task.lastActivity = now;
      task.progress.push("Task approved and started");

      await writeTask(workspaceDir, task);
      emit({
        type: EVENT_TYPES.TASK_APPROVED,
        agentId,
        ts: Date.now(),
        data: { taskId: task.id, workSessionId: task.workSessionId },
      });
      await updateCurrentTaskPointer(workspaceDir, task.id);

      enableAgentManagedMode(agentId);

      return jsonResult({
        success: true,
        taskId: task.id,
        approved: true,
        startedAt: now,
        workSessionId: task.workSessionId,
      });
    },
  };
}

export function createTaskBlockTool(options: {
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
    label: "Task Block",
    name: "task_block",
    description:
      "Block a task that cannot proceed without another agent's help. Specify unblock_by with agent IDs who can help unblock. The system will automatically send unblock requests to those agents (up to 3 times).",
    parameters: TaskBlockSchema,
    execute: async (_toolCallId, params) => {
      const taskIdParam = readStringParam(params, "task_id");
      const reason = readStringParam(params, "reason", { required: true });
      const unblockedAction = readStringParam(params, "unblock_action");

      const rawUnblockBy = (params as Record<string, unknown>).unblock_by;
      const unblockedBy = Array.isArray(rawUnblockBy)
        ? rawUnblockBy.filter((s): s is string => typeof s === "string")
        : [];

      if (unblockedBy.length === 0) {
        return jsonResult({
          success: false,
          error: "unblock_by must be a non-empty array of agent IDs",
        });
      }

      // Validate agent IDs
      const validAgentIds = listAgentIds(cfg);
      const currentAgentId = agentId;
      const invalidIds: string[] = [];
      const selfReferences: string[] = [];

      for (const agentIdToCheck of unblockedBy) {
        if (!validAgentIds.includes(agentIdToCheck)) {
          invalidIds.push(agentIdToCheck);
        }
        if (agentIdToCheck === currentAgentId) {
          selfReferences.push(agentIdToCheck);
        }
      }

      if (invalidIds.length > 0) {
        return jsonResult({
          success: false,
          error: `Invalid agent ID(s) in unblock_by: ${invalidIds.join(", ")}. Valid agents: ${validAgentIds.join(", ")}`,
        });
      }

      if (selfReferences.length > 0) {
        return jsonResult({
          success: false,
          error: `Agent cannot unblock itself. Remove "${selfReferences.join(", ")}" from unblock_by.`,
        });
      }

      // Deduplicate agent IDs
      const uniqueUnblockedBy = [...new Set(unblockedBy)];

      let task: TaskFile | null = null;

      if (taskIdParam) {
        task = await readTask(workspaceDir, taskIdParam);
        if (!task) {
          return jsonResult({
            success: false,
            error: `Task not found: ${taskIdParam}`,
          });
        }
      } else {
        task = await findActiveTask(workspaceDir);
        if (!task) {
          return jsonResult({
            success: false,
            error: "No active task to block. Use task_start first or specify task_id.",
          });
        }
      }

      const lock = await acquireTaskLock(workspaceDir, task.id);
      if (!lock) {
        return jsonResult({
          success: false,
          error: `Task ${task.id} is locked by another operation`,
        });
      }

      try {
        const now = new Date().toISOString();
        task.status = "blocked";
        task.lastActivity = now;
        task.blockedReason = reason;
        task.unblockedBy = uniqueUnblockedBy;
        task.unblockedAction = unblockedAction;
        task.unblockRequestCount = 0;
        task.lastUnblockerIndex = undefined;
        task.lastUnblockRequestAt = undefined;
        task.escalationState = "none";
        task.progress.push(`[BLOCKED] ${reason}`);

        await writeTask(workspaceDir, task);
        emit({
          type: EVENT_TYPES.TASK_BLOCKED,
          agentId,
          ts: Date.now(),
          data: {
            taskId: task.id,
            reason,
            unblockedBy: uniqueUnblockedBy,
            workSessionId: task.workSessionId,
          },
        });
        await updateCurrentTaskPointer(workspaceDir, task.id);

        disableAgentManagedMode(agentId);

        return jsonResult({
          success: true,
          taskId: task.id,
          status: "blocked",
          blockedReason: reason,
          unblockedBy,
          unblockedAction: unblockedAction || null,
          unblockRequestCount: 0,
          workSessionId: task.workSessionId,
          message: `Task blocked. Unblock requests will be sent to: ${unblockedBy.join(", ")}`,
        });
      } finally {
        await lock.release();
      }
    },
  };
}
export function createTaskResumeTool(options: {
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
    label: "Task Resume",
    name: "task_resume",
    description:
      "Resume a blocked task. Transitions task from blocked to in_progress status. If task_id is omitted, resumes the most recently blocked task.",
    parameters: TaskResumeSchema,
    execute: async (_toolCallId, params) => {
      const taskIdParam = readStringParam(params, "task_id");

      let task: TaskFile | null = null;

      if (taskIdParam) {
        task = await readTask(workspaceDir, taskIdParam);
        if (!task) {
          return jsonResult({
            success: false,
            error: `Task not found: ${taskIdParam}`,
          });
        }
      } else {
        const blockedTasks = await findBlockedTasks(workspaceDir);
        task = blockedTasks[0] || null;
        if (!task) {
          return jsonResult({
            success: false,
            error: "No blocked task to resume.",
          });
        }
      }

      if (task.status !== "blocked") {
        return jsonResult({
          success: false,
          error: `Task ${task.id} is not blocked. Current status: ${task.status}`,
        });
      }

      const lock = await acquireTaskLock(workspaceDir, task.id);
      if (!lock) {
        return jsonResult({
          success: false,
          error: `Task ${task.id} is locked by another operation`,
        });
      }

      try {
        const now = new Date().toISOString();
        task.status = "in_progress";
        task.lastActivity = now;
        task.progress.push("Task resumed from blocked state");

        task.blockedReason = undefined;
        task.unblockedBy = undefined;
        task.unblockedAction = undefined;
        task.unblockRequestCount = undefined;
        task.lastUnblockerIndex = undefined;
        task.escalationState = undefined;

        await writeTask(workspaceDir, task);
        emit({
          type: EVENT_TYPES.TASK_RESUMED,
          agentId,
          ts: Date.now(),
          data: { taskId: task.id, workSessionId: task.workSessionId },
        });
        await updateCurrentTaskPointer(workspaceDir, task.id);

        enableAgentManagedMode(agentId);

        return jsonResult({
          success: true,
          taskId: task.id,
          resumed: true,
          resumedAt: now,
          workSessionId: task.workSessionId,
        });
      } finally {
        await lock.release();
      }
    },
  };
}

export function createTaskBacklogAddTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  const currentAgentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Task Backlog Add",
    name: "task_backlog_add",
    description:
      "Add a task to the backlog. Backlog tasks are picked up automatically when no active task exists. Use assignee to add to another agent's backlog. Priority defaults to 'low' for cross-agent requests.",
    parameters: TaskBacklogAddSchema,
    execute: async (_toolCallId, params) => {
      const description = readStringParam(params, "description", { required: true });
      const context = readStringParam(params, "context");
      const priorityRaw = readStringParam(params, "priority") || "medium";
      const estimatedEffortRaw = readStringParam(params, "estimated_effort");
      const startDateRaw = readStringParam(params, "start_date");
      const dueDateRaw = readStringParam(params, "due_date");
      const assigneeRaw = readStringParam(params, "assignee");

      const rawDependsOn = (params as Record<string, unknown>).depends_on;
      const dependsOn = Array.isArray(rawDependsOn)
        ? rawDependsOn.filter((s): s is string => typeof s === "string")
        : undefined;

      const targetAgentId = assigneeRaw || currentAgentId;
      const isCrossAgent = targetAgentId !== currentAgentId;

      if (isCrossAgent) {
        const validAgentIds = listAgentIds(cfg);
        if (!validAgentIds.includes(targetAgentId)) {
          return jsonResult({
            success: false,
            error: `Invalid assignee: ${targetAgentId}. Valid agents: ${validAgentIds.join(", ")}`,
          });
        }
      }

      const priority: TaskPriority = ["low", "medium", "high", "urgent"].includes(priorityRaw)
        ? (priorityRaw as TaskPriority)
        : "medium";

      const estimatedEffort: EstimatedEffort | undefined =
        estimatedEffortRaw && ["small", "medium", "large"].includes(estimatedEffortRaw)
          ? (estimatedEffortRaw as EstimatedEffort)
          : undefined;

      const workspaceDir = resolveAgentWorkspaceDir(cfg, targetAgentId);
      const now = new Date().toISOString();
      const taskId = generateTaskId();
      const workSessionId = generateWorkSessionId();

      const newTask: TaskFile = {
        id: taskId,
        status: "backlog",
        priority,
        description,
        context,
        source: isCrossAgent ? `request:${currentAgentId}` : "self",
        created: now,
        lastActivity: now,
        workSessionId,
        progress: [`Added to backlog${isCrossAgent ? ` by ${currentAgentId}` : ""}`],
        createdBy: currentAgentId,
        assignee: targetAgentId,
        dependsOn: dependsOn && dependsOn.length > 0 ? dependsOn : undefined,
        estimatedEffort,
        startDate: startDateRaw,
        dueDate: dueDateRaw,
        milestoneId: readStringParam(params, "milestone_id"),
        milestoneItemId: readStringParam(params, "milestone_item_id"),
      };

      await writeTask(workspaceDir, newTask);
      emit({
        type: EVENT_TYPES.TASK_BACKLOG_ADDED,
        agentId: currentAgentId,
        ts: Date.now(),
        data: { taskId, assignee: targetAgentId, isCrossAgent, workSessionId },
      });

      const allBacklog = await findAllBacklogTasks(workspaceDir);

      return jsonResult({
        success: true,
        taskId,
        status: "backlog",
        assignee: targetAgentId,
        isCrossAgent,
        priority,
        workSessionId: newTask.workSessionId,
        estimatedEffort: estimatedEffort || null,
        startDate: startDateRaw || null,
        dueDate: dueDateRaw || null,
        dependsOn: dependsOn || [],
        totalBacklogItems: allBacklog.length,
      });
    },
  };
}

export function createTaskPickBacklogTool(options: {
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
    label: "Task Pick Backlog",
    name: "task_pick_backlog",
    description:
      "Pick a task from the backlog and start working on it. If task_id is omitted, picks the highest priority task that meets all conditions (dependencies met, start_date passed).",
    parameters: TaskPickBacklogSchema,
    execute: async (_toolCallId, params) => {
      const activeTask = await findActiveTask(workspaceDir);
      if (activeTask) {
        return jsonResult({
          success: false,
          error: `Already have an active task: ${activeTask.id}. Complete or block it first.`,
          currentTaskId: activeTask.id,
        });
      }

      const taskIdParam = readStringParam(params, "task_id");
      let task: TaskFile | null = null;

      if (taskIdParam) {
        task = await readTask(workspaceDir, taskIdParam);
        if (!task) {
          return jsonResult({
            success: false,
            error: `Task not found: ${taskIdParam}`,
          });
        }
        if (task.status !== "backlog") {
          return jsonResult({
            success: false,
            error: `Task ${taskIdParam} is not in backlog. Status: ${task.status}`,
          });
        }

        const now = new Date();
        if (task.startDate && new Date(task.startDate) > now) {
          return jsonResult({
            success: false,
            error: `Task ${taskIdParam} cannot start until ${task.startDate}`,
          });
        }

        const { met, unmetDeps } = await checkDependenciesMet(workspaceDir, task);
        if (!met) {
          return jsonResult({
            success: false,
            error: `Task ${taskIdParam} has unmet dependencies: ${unmetDeps.join(", ")}`,
            unmetDependencies: unmetDeps,
          });
        }
      } else {
        task = await findPickableBacklogTask(workspaceDir);
        if (!task) {
          const allBacklog = await findAllBacklogTasks(workspaceDir);
          return jsonResult({
            success: false,
            error:
              allBacklog.length > 0
                ? "No pickable backlog task (all have unmet dependencies or future start dates)"
                : "No backlog tasks available",
            totalBacklogItems: allBacklog.length,
          });
        }
      }

      const lock = await acquireTaskLock(workspaceDir, task.id);
      if (!lock) {
        return jsonResult({
          success: false,
          error: `Task ${task.id} is locked by another operation`,
        });
      }

      try {
        const freshTask = await readTask(workspaceDir, task.id);
        if (!freshTask || freshTask.status !== "backlog") {
          return jsonResult({ success: false, error: `Task ${task.id} is no longer in backlog` });
        }

        const now = new Date().toISOString();
        freshTask.status = "in_progress";
        freshTask.lastActivity = now;
        freshTask.progress.push("Picked from backlog and started");

        await writeTask(workspaceDir, freshTask);
        emit({
          type: EVENT_TYPES.TASK_BACKLOG_PICKED,
          agentId,
          ts: Date.now(),
          data: { taskId: freshTask.id, workSessionId: freshTask.workSessionId },
        });
        await updateCurrentTaskPointer(workspaceDir, freshTask.id);

        enableAgentManagedMode(agentId);

        const remainingBacklog = await findAllBacklogTasks(workspaceDir);

        return jsonResult({
          success: true,
          taskId: freshTask.id,
          description: freshTask.description,
          priority: freshTask.priority,
          pickedFromBacklog: true,
          workSessionId: freshTask.workSessionId,
          startedAt: now,
          remainingBacklogItems: remainingBacklog.length,
        });
      } finally {
        await lock.release();
      }
    },
  };
}
