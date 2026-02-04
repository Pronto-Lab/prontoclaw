import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { disableAgentManagedMode, enableAgentManagedMode } from "../../infra/task-tracker.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { jsonResult, readStringParam } from "./common.js";

// Constants
const CURRENT_TASK_FILENAME = "CURRENT_TASK.md";
const TASK_HISTORY_FILENAME = "TASK_HISTORY.md";

// Schemas
const TaskStartSchema = Type.Object({
  description: Type.String(),
  context: Type.Optional(Type.String()),
});

const TaskUpdateSchema = Type.Object({
  progress: Type.String(),
});

const TaskCompleteSchema = Type.Object({
  summary: Type.Optional(Type.String()),
});

const TaskStatusSchema = Type.Object({});

// Types
interface CurrentTask {
  description: string;
  context?: string;
  started: string;
  lastActivity: string;
  progress: string[];
}

// Helper functions
function formatCurrentTaskMd(task: CurrentTask): string {
  const lines = ["# Current Task", "", "## Description", task.description, ""];

  if (task.context) {
    lines.push("## Context", task.context, "");
  }

  lines.push(
    "## Started",
    task.started,
    "",
    "## Last Activity",
    task.lastActivity,
    "",
    "## Progress",
  );

  for (const item of task.progress) {
    lines.push(`- ${item}`);
  }

  lines.push("", "---", "*Managed by agent via task tools*");

  return lines.join("\n");
}

function formatEmptyTaskMd(): string {
  return "*(No task in progress)*\n";
}

function formatTaskHistoryEntry(task: CurrentTask, summary?: string): string {
  const completed = new Date().toISOString();
  const started = new Date(task.started);
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
    `**Started:** ${task.started}`,
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

function parseCurrentTaskMd(content: string): CurrentTask | null {
  if (!content || content.includes("*(No task in progress)*")) {
    return null;
  }

  const lines = content.split("\n");
  let description = "";
  let context: string | undefined;
  let started = "";
  let lastActivity = "";
  const progress: string[] = [];

  let currentSection = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("## ")) {
      currentSection = trimmed.slice(3).toLowerCase();
      continue;
    }

    if (trimmed.startsWith("---") || trimmed.startsWith("*Managed by")) {
      continue;
    }

    if (trimmed.startsWith("# ")) {
      continue;
    }

    if (!trimmed) {
      continue;
    }

    switch (currentSection) {
      case "description":
        description = trimmed;
        break;
      case "context":
        context = trimmed;
        break;
      case "started":
        started = trimmed;
        break;
      case "last activity":
        lastActivity = trimmed;
        break;
      case "progress":
        if (trimmed.startsWith("- ")) {
          progress.push(trimmed.slice(2));
        }
        break;
    }
  }

  if (!description || !started) {
    return null;
  }

  return {
    description,
    context,
    started,
    lastActivity: lastActivity || started,
    progress,
  };
}

async function readCurrentTask(workspaceDir: string): Promise<CurrentTask | null> {
  const filePath = path.join(workspaceDir, CURRENT_TASK_FILENAME);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return parseCurrentTaskMd(content);
  } catch {
    return null;
  }
}

async function writeCurrentTask(workspaceDir: string, task: CurrentTask | null): Promise<void> {
  const filePath = path.join(workspaceDir, CURRENT_TASK_FILENAME);
  await fs.mkdir(workspaceDir, { recursive: true });
  const content = task ? formatCurrentTaskMd(task) : formatEmptyTaskMd();
  await fs.writeFile(filePath, content, "utf-8");
}

async function appendToHistory(workspaceDir: string, entry: string): Promise<void> {
  const filePath = path.join(workspaceDir, TASK_HISTORY_FILENAME);
  await fs.mkdir(workspaceDir, { recursive: true });

  let existingContent = "";
  try {
    existingContent = await fs.readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist, create with header
    existingContent = "# Task History\n";
  }

  await fs.writeFile(filePath, existingContent + entry, "utf-8");
}

function generateTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Tool creators
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
      "Start a new task. Call this when beginning work on a user request. If a previous task exists, it will be automatically archived to TASK_HISTORY.md.",
    parameters: TaskStartSchema,
    execute: async (_toolCallId, params) => {
      const description = readStringParam(params, "description", { required: true });
      const context = readStringParam(params, "context");

      // Check for existing task and archive it
      const existingTask = await readCurrentTask(workspaceDir);
      if (existingTask) {
        const historyEntry = formatTaskHistoryEntry(
          existingTask,
          "(Auto-archived: new task started)",
        );
        await appendToHistory(workspaceDir, historyEntry);
      }

      const now = new Date().toISOString();
      const taskId = generateTaskId();

      const newTask: CurrentTask = {
        description,
        context,
        started: now,
        lastActivity: now,
        progress: ["Task started"],
      };

      await writeCurrentTask(workspaceDir, newTask);

      enableAgentManagedMode(agentId);

      return jsonResult({
        success: true,
        taskId,
        started: now,
        archived: Boolean(existingTask),
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
      "Update the current task's progress. Call this to record progress on the ongoing task. Adds a new item to the Progress section.",
    parameters: TaskUpdateSchema,
    execute: async (_toolCallId, params) => {
      const progress = readStringParam(params, "progress", { required: true });

      const currentTask = await readCurrentTask(workspaceDir);
      if (!currentTask) {
        return jsonResult({
          success: false,
          error: "No current task. Use task_start first.",
        });
      }

      const now = new Date().toISOString();
      currentTask.lastActivity = now;
      currentTask.progress.push(progress);

      await writeCurrentTask(workspaceDir, currentTask);

      return jsonResult({
        success: true,
        updated: now,
        progressCount: currentTask.progress.length,
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
      "Mark the current task as complete. Archives the task to TASK_HISTORY.md and clears CURRENT_TASK.md. Call this when the user's request has been fulfilled.",
    parameters: TaskCompleteSchema,
    execute: async (_toolCallId, params) => {
      const summary = readStringParam(params, "summary");

      const currentTask = await readCurrentTask(workspaceDir);
      if (!currentTask) {
        return jsonResult({
          success: false,
          error: "No current task to complete.",
        });
      }

      // Add completion to progress
      currentTask.progress.push("Task completed");

      // Archive to history
      const historyEntry = formatTaskHistoryEntry(currentTask, summary);
      await appendToHistory(workspaceDir, historyEntry);

      // Clear current task
      await writeCurrentTask(workspaceDir, null);

      disableAgentManagedMode(agentId);

      return jsonResult({
        success: true,
        archived: true,
        archivedTo: TASK_HISTORY_FILENAME,
        completedAt: new Date().toISOString(),
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
      "Get the current task status. Returns task details if a task is in progress, or indicates no task is active.",
    parameters: TaskStatusSchema,
    execute: async () => {
      const currentTask = await readCurrentTask(workspaceDir);

      if (!currentTask) {
        return jsonResult({
          hasTask: false,
          message: "No task in progress",
        });
      }

      return jsonResult({
        hasTask: true,
        task: {
          description: currentTask.description,
          context: currentTask.context,
          started: currentTask.started,
          lastActivity: currentTask.lastActivity,
          progress: currentTask.progress,
        },
      });
    },
  };
}
