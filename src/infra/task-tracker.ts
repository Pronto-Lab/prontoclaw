/**
 * Task Tracker - Automatic CURRENT_TASK.md updates based on agent lifecycle events.
 *
 * When an agent starts processing a message, writes the task to CURRENT_TASK.md.
 * When the agent finishes (end/error), clears the current task section.
 *
 * This enables task-continuation to resume interrupted work on gateway restart.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { logVerbose } from "../globals.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { onAgentEvent, type AgentEventPayload } from "./agent-events.js";

const CURRENT_TASK_FILENAME = "CURRENT_TASK.md";
const TASKS_DIR = "tasks";

/** In-memory map: runId → task context (message body, thread info, start time). */
const runTaskContext = new Map<
  string,
  {
    body: string;
    threadId?: string;
    startedAt: number;
  }
>();

/** Track which agents currently have an active task to avoid duplicate writes. */
const activeAgentTasks = new Map<string, string>();

/**
 * Track which agents are in "agent-managed" mode (using task tools).
 * When an agent uses task tools, auto-clear on lifecycle end is disabled.
 */
const agentManagedMode = new Set<string>();

/**
 * Enable agent-managed mode for an agent.
 * Call this when the agent starts using task tools (e.g., task_start).
 * When enabled, task-tracker will NOT auto-clear CURRENT_TASK.md on lifecycle end.
 */
export function enableAgentManagedMode(agentId: string): void {
  agentManagedMode.add(agentId);
  logVerbose(`task-tracker: enabled agent-managed mode for ${agentId}`);
}

/**
 * Disable agent-managed mode for an agent.
 * Call this when the agent completes their task (e.g., task_complete).
 */
export function disableAgentManagedMode(agentId: string): void {
  agentManagedMode.delete(agentId);
  logVerbose(`task-tracker: disabled agent-managed mode for ${agentId}`);
}

/**
 * Check if an agent is in agent-managed mode.
 */
export function isAgentManagedMode(agentId: string): boolean {
  return agentManagedMode.has(agentId);
}

async function hasActiveTaskFiles(workspaceDir: string): Promise<boolean> {
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  try {
    const files = await fs.readdir(tasksDir);
    return files.some((f) => f.startsWith("task_") && f.endsWith(".md"));
  } catch {
    return false;
  }
}

/** Unsubscribe function from agent events. */
let unsubscribe: (() => void) | null = null;

/**
 * Register task context for a run before the agent starts processing.
 * Call this when you have access to both runId and the message body.
 */
export function registerTaskContext(
  runId: string,
  params: { body: string; threadId?: string },
): void {
  if (!runId) {
    return;
  }
  runTaskContext.set(runId, {
    body: params.body,
    threadId: params.threadId,
    startedAt: Date.now(),
  });
  logVerbose(`task-tracker: registered context for run ${runId.slice(0, 8)}`);
}

/**
 * Clear task context for a run (called automatically on lifecycle end).
 */
export function clearTaskContext(runId: string): void {
  runTaskContext.delete(runId);
}

/**
 * Start the task tracker - subscribes to agent lifecycle events.
 * Returns unsubscribe function.
 */
export function startTaskTracker(cfg: OpenClawConfig): () => void {
  if (unsubscribe) {
    logVerbose("task-tracker: already running, skipping duplicate start");
    return unsubscribe;
  }

  logVerbose("task-tracker: starting lifecycle event listener");

  unsubscribe = onAgentEvent((evt: AgentEventPayload) => {
    if (evt.stream !== "lifecycle") {
      return;
    }

    const phase = evt.data.phase as string | undefined;
    const { runId, sessionKey } = evt;

    if (!sessionKey) {
      return;
    }

    if (phase === "start") {
      void handleTaskStart(cfg, runId, sessionKey);
    } else if (phase === "end" || phase === "error") {
      void handleTaskEnd(cfg, runId, sessionKey, phase);
    }
  });

  return unsubscribe;
}

/**
 * Stop the task tracker.
 */
export function stopTaskTracker(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
    logVerbose("task-tracker: stopped");
  }
}

async function handleTaskStart(
  cfg: OpenClawConfig,
  runId: string,
  sessionKey: string,
): Promise<void> {
  try {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const taskCtx = runTaskContext.get(runId);

    // Skip if no task context registered (e.g., heartbeat or internal message)
    if (!taskCtx) {
      logVerbose(`task-tracker: no context for run ${runId.slice(0, 8)}, skipping`);
      return;
    }

    // Skip if this agent already has an active task from a different run
    const existingRun = activeAgentTasks.get(agentId);
    if (existingRun && existingRun !== runId) {
      logVerbose(`task-tracker: agent ${agentId} already has active task, skipping`);
      return;
    }

    activeAgentTasks.set(agentId, runId);

    // Skip if agent is in agent-managed mode (using task tools)
    if (agentManagedMode.has(agentId)) {
      logVerbose(`task-tracker: agent ${agentId} is in agent-managed mode, skipping auto-write`);
      return;
    }

    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const taskFilePath = path.join(workspaceDir, CURRENT_TASK_FILENAME);

    // Check if file was created by task tools (persists across restarts)
    try {
      const existingContent = await fs.readFile(taskFilePath, "utf-8");
      if (existingContent.includes("*Managed by agent via task tools*")) {
        logVerbose(`task-tracker: file has agent-managed marker, skipping auto-write`);
        return;
      }
    } catch {
      // File doesn't exist, proceed with write
    }

    // Check if tasks/ directory has active task files (multi-task mode)
    if (await hasActiveTaskFiles(workspaceDir)) {
      logVerbose(`task-tracker: tasks/ directory has active files, skipping auto-write`);
      return;
    }

    const content = formatCurrentTaskMd({
      task: truncateBody(taskCtx.body),
      threadId: taskCtx.threadId,
      startedAt: taskCtx.startedAt,
    });

    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(taskFilePath, content, "utf-8");

    logVerbose(`task-tracker: wrote CURRENT_TASK.md for agent ${agentId}`);
  } catch (err) {
    logVerbose(`task-tracker: failed to write task start: ${String(err)}`);
  }
}

async function handleTaskEnd(
  cfg: OpenClawConfig,
  runId: string,
  sessionKey: string,
  phase: string,
): Promise<void> {
  try {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);

    // Only clear if this run owns the active task
    const activeRun = activeAgentTasks.get(agentId);
    if (activeRun !== runId) {
      logVerbose(`task-tracker: run ${runId.slice(0, 8)} doesn't own active task, skipping clear`);
      clearTaskContext(runId);
      return;
    }

    activeAgentTasks.delete(agentId);
    clearTaskContext(runId);

    // Skip auto-clear if agent is using task tools (agent-managed mode)
    if (agentManagedMode.has(agentId)) {
      logVerbose(`task-tracker: agent ${agentId} is in agent-managed mode, skipping auto-clear`);
      return;
    }

    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const taskFilePath = path.join(workspaceDir, CURRENT_TASK_FILENAME);

    // Check if file was created by task tools (persists across restarts)
    try {
      const existingContent = await fs.readFile(taskFilePath, "utf-8");
      if (existingContent.includes("*Managed by agent via task tools*")) {
        logVerbose(`task-tracker: file has agent-managed marker, skipping auto-clear`);
        return;
      }
    } catch {
      // File doesn't exist, proceed with clear
    }

    if (await hasActiveTaskFiles(workspaceDir)) {
      logVerbose(`task-tracker: tasks/ directory has active files, skipping auto-clear`);
      return;
    }

    const content = formatEmptyCurrentTaskMd(phase === "error");

    await fs.writeFile(taskFilePath, content, "utf-8");

    logVerbose(`task-tracker: cleared CURRENT_TASK.md for agent ${agentId} (${phase})`);
  } catch (err) {
    logVerbose(`task-tracker: failed to write task end: ${String(err)}`);
  }
}

function truncateBody(body: string, maxLen = 500): string {
  const cleaned = body.trim().replace(/\n+/g, " ").replace(/\s+/g, " ");
  if (cleaned.length <= maxLen) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLen)}...`;
}

function formatCurrentTaskMd(params: {
  task: string;
  threadId?: string;
  startedAt: number;
}): string {
  const timestamp = new Date(params.startedAt).toISOString();
  const lines = ["# Current Task", "", "## Current", "", `**Task:** ${params.task}`];

  if (params.threadId) {
    lines.push(`**Thread ID:** ${params.threadId}`);
  }

  lines.push(`**Started:** ${timestamp}`);
  lines.push("**Progress:**");
  lines.push("- [ ] Processing message...");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*This file is auto-generated by task-tracker. Do not edit manually.*");

  return lines.join("\n");
}

function formatEmptyCurrentTaskMd(hadError: boolean): string {
  const status = hadError ? "*(Last task ended with error)*" : "*(No task in progress)*";
  return [
    "# Current Task",
    "",
    "## Current",
    "",
    status,
    "",
    "---",
    "",
    "*This file is auto-generated by task-tracker. Do not edit manually.*",
  ].join("\n");
}

/** For testing: reset all internal state. */
export function resetTaskTrackerForTest(): void {
  runTaskContext.clear();
  activeAgentTasks.clear();
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
