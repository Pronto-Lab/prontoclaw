import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { disableAgentManagedMode, enableAgentManagedMode } from "../../infra/task-tracker.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { jsonResult, readStringParam } from "./common.js";

const TASKS_DIR = "tasks";
const TASK_HISTORY_DIR = "task-history";
const CURRENT_TASK_FILENAME = "CURRENT_TASK.md";

function getMonthlyHistoryFilename(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}.md`;
}

export type TaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface TaskFile {
  id: string;
  status: TaskStatus;
  priority: TaskPriority;
  description: string;
  context?: string;
  source?: string;
  created: string;
  lastActivity: string;
  progress: string[];
}

const TaskStartSchema = Type.Object({
  description: Type.String(),
  context: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String()),
});

const TaskUpdateSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
  progress: Type.String(),
});

const TaskCompleteSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
});

const TaskStatusSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
});

const TaskListSchema = Type.Object({
  status: Type.Optional(Type.String()),
});

const TaskCancelSchema = Type.Object({
  task_id: Type.String(),
  reason: Type.Optional(Type.String()),
});

function generateTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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

  lines.push("", "## Description", task.description, "");

  if (task.context) {
    lines.push("## Context", task.context, "");
  }

  lines.push("## Progress");
  for (const item of task.progress) {
    lines.push(`- ${item}`);
  }

  lines.push("", "## Last Activity", task.lastActivity, "", "---", "*Managed by task tools*");

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
  let created = "";
  let lastActivity = "";
  const progress: string[] = [];

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
        status = statusMatch[1] as TaskStatus;
      }
      const priorityMatch = trimmed.match(/^-?\s*\*\*Priority:\*\*\s*(.+)$/);
      if (priorityMatch) {
        priority = priorityMatch[1] as TaskPriority;
      }
      const createdMatch = trimmed.match(/^-?\s*\*\*Created:\*\*\s*(.+)$/);
      if (createdMatch) {
        created = createdMatch[1];
      }
      const sourceMatch = trimmed.match(/^-?\s*\*\*Source:\*\*\s*(.+)$/);
      if (sourceMatch) {
        source = sourceMatch[1];
      }
    } else if (currentSection === "description") {
      description = trimmed;
    } else if (currentSection === "context") {
      context = trimmed;
    } else if (currentSection === "last activity") {
      lastActivity = trimmed;
    } else if (currentSection === "progress") {
      if (trimmed.startsWith("- ")) {
        progress.push(trimmed.slice(2));
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
    created,
    lastActivity: lastActivity || created,
    progress,
  };
}

async function getTasksDir(workspaceDir: string): Promise<string> {
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  await fs.mkdir(tasksDir, { recursive: true });
  return tasksDir;
}

async function readTask(workspaceDir: string, taskId: string): Promise<TaskFile | null> {
  const tasksDir = await getTasksDir(workspaceDir);
  const filePath = path.join(tasksDir, `${taskId}.md`);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return parseTaskFileMd(content, `${taskId}.md`);
  } catch {
    return null;
  }
}

async function writeTask(workspaceDir: string, task: TaskFile): Promise<void> {
  const tasksDir = await getTasksDir(workspaceDir);
  const filePath = path.join(tasksDir, `${task.id}.md`);
  const content = formatTaskFileMd(task);
  await fs.writeFile(filePath, content, "utf-8");
}

async function deleteTask(workspaceDir: string, taskId: string): Promise<void> {
  const tasksDir = await getTasksDir(workspaceDir);
  const filePath = path.join(tasksDir, `${taskId}.md`);
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

  try {
    const files = await fs.readdir(tasksDir);
    for (const file of files) {
      if (!file.endsWith(".md") || !file.startsWith("task_")) {
        continue;
      }
      const filePath = path.join(tasksDir, file);
      const content = await fs.readFile(filePath, "utf-8");
      const task = parseTaskFileMd(content, file);
      if (task) {
        if (!statusFilter || statusFilter === "all" || task.status === statusFilter) {
          tasks.push(task);
        }
      }
    }
  } catch {
    // Directory doesn't exist or is empty
  }

  tasks.sort((a, b) => {
    const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) {
      return priorityDiff;
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

async function appendToHistory(workspaceDir: string, entry: string): Promise<string> {
  const historyDir = path.join(workspaceDir, TASK_HISTORY_DIR);
  await fs.mkdir(historyDir, { recursive: true });

  const filename = getMonthlyHistoryFilename();
  const filePath = path.join(historyDir, filename);

  let existingContent = "";
  try {
    existingContent = await fs.readFile(filePath, "utf-8");
  } catch {
    const now = new Date();
    const monthName = now.toLocaleString("en-US", { month: "long", year: "numeric" });
    existingContent = `# Task History - ${monthName}\n`;
  }

  await fs.writeFile(filePath, existingContent + entry, "utf-8");
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

async function hasActiveTasks(workspaceDir: string): Promise<boolean> {
  const tasks = await listTasks(workspaceDir);
  return tasks.some((t) => t.status === "in_progress" || t.status === "pending");
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
      "Start a new task. Creates a task file in tasks/ directory. Multiple tasks can exist simultaneously. Returns the task_id for future reference.",
    parameters: TaskStartSchema,
    execute: async (_toolCallId, params) => {
      const description = readStringParam(params, "description", { required: true });
      const context = readStringParam(params, "context");
      const priorityRaw = readStringParam(params, "priority") || "medium";
      const priority = ["low", "medium", "high", "urgent"].includes(priorityRaw)
        ? (priorityRaw as TaskPriority)
        : "medium";

      const now = new Date().toISOString();
      const taskId = generateTaskId();

      const newTask: TaskFile = {
        id: taskId,
        status: "in_progress",
        priority,
        description,
        context,
        source: "user",
        created: now,
        lastActivity: now,
        progress: ["Task started"],
      };

      await writeTask(workspaceDir, newTask);
      await updateCurrentTaskPointer(workspaceDir, taskId);

      enableAgentManagedMode(agentId);

      const allTasks = await listTasks(workspaceDir);

      return jsonResult({
        success: true,
        taskId,
        started: now,
        priority,
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
      "Update a task's progress. If task_id is omitted, updates the most recent in_progress task. Adds a new item to the Progress section.",
    parameters: TaskUpdateSchema,
    execute: async (_toolCallId, params) => {
      const taskIdParam = readStringParam(params, "task_id");
      const progress = readStringParam(params, "progress", { required: true });

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

      const now = new Date().toISOString();
      task.lastActivity = now;
      task.progress.push(progress);

      await writeTask(workspaceDir, task);
      await updateCurrentTaskPointer(workspaceDir, task.id);

      return jsonResult({
        success: true,
        taskId: task.id,
        updated: now,
        progressCount: task.progress.length,
      });
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

      task.progress.push("Task completed");
      task.status = "completed";

      const historyEntry = formatTaskHistoryEntry(task, summary);
      const archivedTo = await appendToHistory(workspaceDir, historyEntry);

      await deleteTask(workspaceDir, task.id);

      const remainingTasks = await listTasks(workspaceDir);
      const nextTask = remainingTasks.find((t) => t.status === "in_progress") || null;

      await updateCurrentTaskPointer(workspaceDir, nextTask?.id || null);

      if (!(await hasActiveTasks(workspaceDir))) {
        disableAgentManagedMode(agentId);
      }

      return jsonResult({
        success: true,
        taskId: task.id,
        archived: true,
        archivedTo,
        completedAt: new Date().toISOString(),
        remainingTasks: remainingTasks.length,
        nextTaskId: nextTask?.id || null,
      });
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
            progressCount: task.progress.length,
            latestProgress: task.progress[task.progress.length - 1],
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
          blocked: allTasks.filter((t) => t.status === "blocked").length,
        },
        currentFocus: activeTask
          ? {
              id: activeTask.id,
              description: activeTask.description,
              priority: activeTask.priority,
            }
          : null,
        tasks: allTasks.map((t) => ({
          id: t.id,
          status: t.status,
          priority: t.priority,
          description: t.description.slice(0, 50) + (t.description.length > 50 ? "..." : ""),
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
      "List all tasks. Optionally filter by status: 'all', 'pending', 'in_progress', 'blocked'. Returns tasks sorted by priority then creation time.",
    parameters: TaskListSchema,
    execute: async (_toolCallId, params) => {
      const statusParam = readStringParam(params, "status") || "all";
      const statusFilter = ["all", "pending", "in_progress", "blocked"].includes(statusParam)
        ? (statusParam as TaskStatus | "all")
        : "all";

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
          progressCount: t.progress.length,
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

      task.status = "cancelled";
      task.progress.push(`Task cancelled${reason ? `: ${reason}` : ""}`);

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

      return jsonResult({
        success: true,
        taskId: task.id,
        cancelled: true,
        reason: reason || null,
        remainingTasks: remainingTasks.length,
      });
    },
  };
}
