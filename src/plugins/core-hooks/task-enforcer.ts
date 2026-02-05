/**
 * Task Enforcer Core Hook
 *
 * Forces agents to call task_start() before any "work" tools (write, edit, bash, etc).
 * When a work tool is called without task_start, it's blocked with a clear error message.
 * The agent retries with task_start first, ensuring 100% task tracking.
 *
 * Now also checks actual task files on disk to recover state after gateway restart.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PluginRegistry } from "../registry.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "../types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadConfig } from "../../config/config.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";

const log = createSubsystemLogger("task-enforcer");

const taskStartedSessions = new Map<string, boolean>();

const EXEMPT_TOOLS = new Set([
  "task_start",
  "task_complete",
  "task_update",
  "task_list",
  "task_status",
  "task_cancel",
  "task_approve",
  "read",
  "glob",
  "grep",
  "lsp_diagnostics",
  "lsp_symbols",
  "lsp_goto_definition",
  "lsp_find_references",
  "todoread",
  "session_read",
  "session_search",
  "session_list",
  "session_info",
  "message",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "session_status",
  "web_search",
  "web_fetch",
]);

const ENFORCED_TOOLS = new Set([
  "write",
  "edit",
  "bash",
  "exec",
]);

function getSessionKey(ctx: PluginHookToolContext): string | null {
  if (!ctx.agentId) {
    return null;
  }
  return `${ctx.agentId}:${ctx.sessionKey ?? "main"}`;
}

/**
 * Check if there are active task files in the workspace's tasks/ directory.
 * This recovers state after gateway restart.
 */
async function hasActiveTaskFiles(workspaceDir: string): Promise<boolean> {
  const tasksDir = path.join(workspaceDir, "tasks");
  try {
    const files = await fs.readdir(tasksDir);
    // Check if any task_*.md files exist
    const hasTaskFiles = files.some((f) => f.startsWith("task_") && f.endsWith(".md"));
    if (!hasTaskFiles) {
      return false;
    }
    // Read each task file to check if any are in_progress or pending
    for (const file of files) {
      if (!file.startsWith("task_") || !file.endsWith(".md")) continue;
      try {
        const content = await fs.readFile(path.join(tasksDir, file), "utf-8");
        if (content.includes("**Status:** in_progress") || 
            content.includes("**Status:** pending") ||
            content.includes("**Status:** pending_approval")) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function taskEnforcerHandler(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
): Promise<PluginHookBeforeToolCallResult | void> {
  const toolName = event.toolName;

  if (EXEMPT_TOOLS.has(toolName)) {
    return;
  }

  if (toolName === "task_start") {
    const sessionKey = getSessionKey(ctx);
    if (sessionKey) {
      taskStartedSessions.set(sessionKey, true);
      log.debug(`task_start called for session: ${sessionKey}`);
    }
    return;
  }

  if (toolName === "task_complete") {
    const sessionKey = getSessionKey(ctx);
    if (sessionKey) {
      taskStartedSessions.delete(sessionKey);
      log.debug(`task_complete called for session: ${sessionKey}`);
    }
    return;
  }

  const shouldEnforce = ENFORCED_TOOLS.has(toolName);

  if (!shouldEnforce) {
    return;
  }

  const sessionKey = getSessionKey(ctx);
  if (!sessionKey) {
    return;
  }

  // First check in-memory cache
  let hasStartedTask = taskStartedSessions.get(sessionKey) === true;

  // If not in cache, check actual task files on disk (recovery after restart)
  if (!hasStartedTask && ctx.agentId) {
    try {
      const cfg = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(cfg, ctx.agentId);
      if (workspaceDir) {
        const hasTasksOnDisk = await hasActiveTaskFiles(workspaceDir);
        if (hasTasksOnDisk) {
          // Recover state: mark session as having an active task
          taskStartedSessions.set(sessionKey, true);
          hasStartedTask = true;
          log.info(`Recovered task state from disk for session ${sessionKey}`);
        }
      }
    } catch (err) {
      log.debug(`Failed to check task files for ${sessionKey}: ${String(err)}`);
    }
  }

  if (!hasStartedTask) {
    log.info(`Blocking ${toolName} for session ${sessionKey} - task_start not called yet`);
    return {
      block: true,
      blockReason:
        `TASK TRACKING REQUIRED: You must call task_start() before using ${toolName}. ` +
        `This is mandatory for all work. Call task_start() first with a brief description ` +
        `of what you're about to do, then retry this tool.`,
    };
  }

  return;
}

export function registerTaskEnforcerHook(registry: PluginRegistry): void {
  registry.typedHooks.push({
    pluginId: "core:task-enforcer",
    hookName: "before_tool_call",
    handler: taskEnforcerHandler,
    priority: 1000,
    source: "core",
  });
  log.info("Task enforcer hook registered");
}

export function clearTaskEnforcerState(): void {
  taskStartedSessions.clear();
}

export function hasActiveTask(agentId: string, sessionKey?: string): boolean {
  const key = `${agentId}:${sessionKey ?? "main"}`;
  return taskStartedSessions.get(key) === true;
}

/**
 * Mark a session as having an active task.
 * Useful for external initialization (e.g., on gateway start).
 */
export function markTaskStarted(agentId: string, sessionKey?: string): void {
  const key = `${agentId}:${sessionKey ?? "main"}`;
  taskStartedSessions.set(key, true);
}
