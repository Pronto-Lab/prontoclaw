/**
 * Quality Enforcer Core Hook
 *
 * Enforces read-before-write discipline and provides audit logging for
 * file mutations and command executions. Agents must read a file before
 * modifying it, ensuring they understand the current state.
 */

import path from "node:path";
import type { PluginRegistry } from "../registry.js";
import type {
  PluginHookAfterToolCallEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "../types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("quality-enforcer");

// ---------------------------------------------------------------------------
// Session tracking: which files each session has read
// ---------------------------------------------------------------------------

type SessionState = {
  readFiles: Set<string>;
  lastActivity: number;
};

const sessionStates = new Map<string, SessionState>();

const SESSION_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function cleanupStaleSessions(): void {
  const now = Date.now();
  for (const [key, state] of sessionStates) {
    if (now - state.lastActivity > SESSION_STALE_MS) {
      sessionStates.delete(key);
      log.debug("Cleaned up stale quality-enforcer session: " + key);
    }
  }
}

function getSessionKey(ctx: PluginHookToolContext): string | null {
  if (!ctx.agentId) {
    return null;
  }
  return ctx.agentId + ":" + (ctx.sessionKey ?? "main");
}

function getOrCreateSession(key: string): SessionState {
  let state = sessionStates.get(key);
  if (!state) {
    state = { readFiles: new Set(), lastActivity: Date.now() };
    sessionStates.set(key, state);
  }
  state.lastActivity = Date.now();
  return state;
}

/**
 * Extract file path from tool params. Tools use path or filePath.
 */
function extractFilePath(params: Record<string, unknown>): string | null {
  const raw =
    typeof params.filePath === "string"
      ? params.filePath
      : typeof params.path === "string"
        ? params.path
        : null;
  if (!raw || !raw.trim()) {
    return null;
  }
  return path.normalize(raw.trim());
}

// ---------------------------------------------------------------------------
// Hook 1: before_tool_call - Read-Before-Write Gate
// ---------------------------------------------------------------------------

const WRITE_TOOLS = new Set(["write", "edit"]);

export async function qualityGateHandler(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
): Promise<PluginHookBeforeToolCallResult | void> {
  // Exempt sub-agent sessions.
  if (ctx.sessionKey && ctx.sessionKey.includes("subagent:")) {
    return;
  }

  const sessionKey = getSessionKey(ctx);
  if (!sessionKey) {
    return;
  }

  const toolName = event.toolName;

  // Track read calls
  if (toolName === "read") {
    const filePath = extractFilePath(event.params);
    if (filePath) {
      const session = getOrCreateSession(sessionKey);
      session.readFiles.add(filePath);
      log.debug("Tracked read: session=" + sessionKey + " file=" + filePath);
    }
    return;
  }

  // Gate write/edit calls
  if (WRITE_TOOLS.has(toolName)) {
    const filePath = extractFilePath(event.params);
    if (!filePath) {
      return; // Cannot determine file path - let it through
    }

    const session = getOrCreateSession(sessionKey);
    if (!session.readFiles.has(filePath)) {
      log.info(
        "Blocking " +
          toolName +
          " for session " +
          sessionKey +
          " - file not read first: " +
          filePath,
      );
      return {
        block: true,
        blockReason:
          "QUALITY GATE: You must read a file before modifying it. " +
          "Use read() on '" +
          filePath +
          "' first to understand its current content, then retry. " +
          "This applies even for new files - reading confirms whether the file exists.",
      };
    }
  }

  return;
}

// ---------------------------------------------------------------------------
// Hook 2: after_tool_call - Audit Logging
// ---------------------------------------------------------------------------

const AUDITED_TOOLS = new Set(["write", "edit", "exec"]);

export async function auditLogHandler(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,
): Promise<void> {
  if (!AUDITED_TOOLS.has(event.toolName)) {
    return;
  }

  const agent = ctx.agentId ?? "unknown";
  const session = ctx.sessionKey ?? "unknown";
  const duration = event.durationMs ?? 0;
  const success = !event.error;

  log.info(
    "[quality-audit] tool=" +
      event.toolName +
      " agent=" +
      agent +
      " session=" +
      session +
      " duration=" +
      duration +
      "ms success=" +
      success,
  );

  // Extra warning for failed exec calls
  if (event.toolName === "exec" && event.error) {
    log.warn(
      "[quality-audit] exec failed: agent=" + agent + " error=" + String(event.error).slice(0, 200),
    );
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerQualityEnforcerHook(registry: PluginRegistry): void {
  registry.typedHooks.push({
    pluginId: "core:quality-enforcer",
    hookName: "before_tool_call",
    handler: qualityGateHandler,
    priority: 900,
    source: "core",
  });

  registry.typedHooks.push({
    pluginId: "core:quality-enforcer",
    hookName: "after_tool_call",
    handler: auditLogHandler,
    priority: 0,
    source: "core",
  });

  if (!cleanupTimer) {
    cleanupTimer = setInterval(cleanupStaleSessions, SESSION_CLEANUP_INTERVAL_MS);
    if (cleanupTimer.unref) {
      cleanupTimer.unref();
    }
  }

  log.info("Quality enforcer hook registered");
}

export function clearQualityEnforcerState(): void {
  sessionStates.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  log.debug("Quality enforcer state cleared");
}
