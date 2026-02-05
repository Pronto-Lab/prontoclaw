/**
 * Task Enforcer Core Hook
 *
 * Forces agents to call task_start() before any "work" tools (write, edit, bash, etc).
 * When a work tool is called without task_start, it's blocked with a clear error message.
 * The agent retries with task_start first, ensuring 100% task tracking.
 */

import type { PluginRegistry } from "../registry.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "../types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("task-enforcer");

const taskStartedSessions = new Map<string, boolean>();

const EXEMPT_TOOLS = new Set([
  "task_start",
  "task_complete",
  "task_update",
  "task_list",
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
]);

const ENFORCED_TOOLS = new Set([
  "write",
  "edit",
  "bash",
  "delegate_task",
  "task",
  "webfetch",
  "google_search",
]);

function getSessionKey(ctx: PluginHookToolContext): string | null {
  if (!ctx.agentId) {
    return null;
  }
  return `${ctx.agentId}:${ctx.sessionKey ?? "main"}`;
}

export function taskEnforcerHandler(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
): PluginHookBeforeToolCallResult | void {
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

  const shouldEnforce = ENFORCED_TOOLS.has(toolName) || toolName.startsWith("mcp_");

  if (!shouldEnforce) {
    return;
  }

  const sessionKey = getSessionKey(ctx);
  if (!sessionKey) {
    return;
  }

  const hasStartedTask = taskStartedSessions.get(sessionKey) === true;

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
