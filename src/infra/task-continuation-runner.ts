import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { findActiveTask, findBlockedTasks, findPendingTasks, writeTask, type TaskFile } from "../agents/tools/task-tool.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { agentCommand } from "../commands/agent.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueSize } from "../process/command-queue.js";
// CommandLane import removed - using agent-specific lanes
import { resolveAgentBoundAccountId } from "../routing/bindings.js";
import { normalizeAgentId } from "../routing/session-key.js";

const log = createSubsystemLogger("task-continuation");

const DEFAULT_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_IDLE_THRESHOLD_MS = 3 * 60 * 1000;
const CONTINUATION_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_UNBLOCK_REQUESTS = 3;
const UNBLOCK_COOLDOWN_MS = 30 * 60 * 1000;

// Failure-based backoff configuration
const BACKOFF_MS = {
  rate_limit: 1 * 60 * 1000,     // 1 minute default (may be overridden by quota reset time)
  billing: 60 * 60 * 1000,       // 1 hour
  timeout: 1 * 60 * 1000,        // 1 minute
  context_overflow: 30 * 60 * 1000, // 30 minutes (needs manual intervention)
  unknown: 5 * 60 * 1000,        // 5 minutes (default)
} as const;

// Minimum backoff for rate limits to avoid hammering the API
const MIN_RATE_LIMIT_BACKOFF_MS = 10 * 1000; // 10 seconds

type FailureReason = keyof typeof BACKOFF_MS;

type ParsedFailure = {
  reason: FailureReason;
  /** Suggested backoff from error message (e.g., "reset after 30s") */
  suggestedBackoffMs?: number;
};

export type TaskContinuationConfig = {
  checkInterval?: string;
  idleThreshold?: string;
  enabled?: boolean;
};

export type TaskContinuationRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
  checkNow: () => Promise<void>;
};

type AgentContinuationState = {
  lastContinuationSentMs: number;
  lastTaskId: string | null;
  /** If set, skip continuation attempts until this timestamp */
  backoffUntilMs?: number;
  /** Number of consecutive failures for exponential backoff */
  consecutiveFailures?: number;
  /** Last failure reason for debugging */
  lastFailureReason?: FailureReason;
};

const agentStates = new Map<string, AgentContinuationState>();

/** @internal - For testing only. Clears all agent continuation state. */
export function __resetAgentStates(): void {
  agentStates.clear();
}

/**
 * Parse quota reset time from error message.
 * Looks for patterns like "reset after 30s", "reset after 0s", "retry after 60 seconds"
 */
function parseQuotaResetTimeMs(message: string): number | null {
  // Match patterns like "reset after 30s", "reset after 0s", "retry after 60 seconds"
  const match = message.match(/(?:reset|retry)\s+after\s+(\d+)\s*s(?:econds?)?/i);
  if (match) {
    const seconds = parseInt(match[1], 10);
    if (!isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  return null;
}

/**
 * Parse failure reason from error message.
 * Returns a categorized reason for backoff calculation.
 */
function parseFailureReason(error: unknown): ParsedFailure {
  const message = error instanceof Error ? error.message : String(error);

  // Rate limit / quota exhaustion
  if (
    /rate.?limit|quota|429|too many requests|all models failed.*rate/i.test(message)
  ) {
    const suggestedBackoffMs = parseQuotaResetTimeMs(message);
    return { 
      reason: "rate_limit",
      suggestedBackoffMs: suggestedBackoffMs !== null ? suggestedBackoffMs : undefined,
    };
  }

  // Billing / payment issues
  if (/billing|payment|insufficient|credit/i.test(message)) {
    return { reason: "billing" };
  }

  // Timeout
  if (/timeout|timed out|deadline exceeded/i.test(message)) {
    return { reason: "timeout" };
  }

  // Context overflow
  if (/context.*overflow|token.*limit|too long|max.*token/i.test(message)) {
    return { reason: "context_overflow" };
  }

  return { reason: "unknown" };
}

/**
 * Calculate backoff duration based on failure reason and consecutive failures.
 * Uses exponential backoff with a cap.
 */
function resolveBackoffMs(
  reason: FailureReason, 
  consecutiveFailures: number,
  suggestedBackoffMs?: number,
): number {
  // For rate limits with a suggested backoff from the error message, use it
  if (reason === "rate_limit" && suggestedBackoffMs !== undefined) {
    // Apply minimum backoff to avoid hammering, but respect the API's suggestion
    const effectiveBackoff = Math.max(suggestedBackoffMs, MIN_RATE_LIMIT_BACKOFF_MS);
    log.debug("Using quota reset time from error message", {
      suggestedMs: suggestedBackoffMs,
      effectiveMs: effectiveBackoff,
    });
    return effectiveBackoff;
  }

  const baseMs = BACKOFF_MS[reason];
  // Exponential backoff: base * 2^(failures-1), capped at 2 hours
  const multiplier = Math.min(Math.pow(2, Math.max(0, consecutiveFailures - 1)), 8);
  const backoffMs = baseMs * multiplier;
  const maxBackoffMs = 2 * 60 * 60 * 1000; // 2 hours max
  return Math.min(backoffMs, maxBackoffMs);
}

function resolveTaskContinuationConfig(cfg: OpenClawConfig): {
  enabled: boolean;
  checkIntervalMs: number;
  idleThresholdMs: number;
} {
  const tcConfig = cfg.agents?.defaults?.taskContinuation;
  const enabled = tcConfig?.enabled ?? true;

  let checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS;
  if (tcConfig?.checkInterval) {
    try {
      checkIntervalMs = parseDurationMs(tcConfig.checkInterval, { defaultUnit: "m" });
    } catch {
      checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS;
    }
  }

  let idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS;
  if (tcConfig?.idleThreshold) {
    try {
      idleThresholdMs = parseDurationMs(tcConfig.idleThreshold, { defaultUnit: "m" });
    } catch {
      idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS;
    }
  }

  return { enabled, checkIntervalMs, idleThresholdMs };
}

function formatUnblockRequestPrompt(
  blockedAgentId: string,
  task: TaskFile,
): string {
  const lines = [
    `[SYSTEM - UNBLOCK REQUEST]`,
    ``,
    `Agent "${blockedAgentId}" needs your help to continue their task.`,
    ``,
    `**Blocked Task ID:** ${task.id}`,
    `**Task Description:** ${task.description}`,
    `**Blocked Reason:** ${task.blockedReason || "No reason provided"}`,
  ];

  if (task.unblockedAction) {
    lines.push(`**Required Action:** ${task.unblockedAction}`);
  }

  if (task.progress.length > 0) {
    const lastProgress = task.progress[task.progress.length - 1];
    lines.push(`**Latest Progress:** ${lastProgress}`);
  }

  lines.push(``);
  lines.push(`Please help unblock this task by taking the necessary action.`);
  lines.push(`After helping, you can notify the blocked agent or let them know the blocker is resolved.`);

  return lines.join("\n");
}

function formatContinuationPrompt(task: TaskFile, pendingCount: number): string {
  const lines = [
    `[SYSTEM REMINDER - TASK CONTINUATION]`,
    ``,
    `You have an in_progress task that needs attention:`,
    ``,
    `**Task ID:** ${task.id}`,
    `**Description:** ${task.description}`,
    `**Priority:** ${task.priority}`,
    `**Last Activity:** ${task.lastActivity}`,
  ];

  if (task.progress.length > 0) {
    const lastProgress = task.progress[task.progress.length - 1];
    lines.push(`**Latest Progress:** ${lastProgress}`);
  }

  lines.push(``);
  lines.push(
    `Please continue working on this task. Use task_update() to log progress and task_complete() when finished.`,
  );

  if (pendingCount > 0) {
    lines.push(``);
    lines.push(`Note: You have ${pendingCount} more pending task(s) waiting after this one.`);
  }

  return lines.join("\n");
}

async function checkAgentForContinuation(
  cfg: OpenClawConfig,
  agentId: string,
  idleThresholdMs: number,
  nowMs: number,
): Promise<boolean> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  // Check agent-specific queue, not global main queue
  // Agent lanes follow pattern: session:agent:{agentId}:main
  const agentLane = `session:agent:${agentId}:main`;
  const agentQueueSize = getQueueSize(agentLane);
  if (agentQueueSize > 0) {
    log.debug("Agent busy, skipping continuation check", { agentId, queueSize: agentQueueSize });
    return false;
  }

  const activeTask = await findActiveTask(workspaceDir);
  if (!activeTask) {
    agentStates.delete(agentId);
    return false;
  }

  if (activeTask.status === "pending_approval" || activeTask.status === "blocked") {
    log.debug("Task is pending_approval or blocked, skipping continuation", {
      agentId,
      taskId: activeTask.id,
    });
    return false;
  }

  const lastActivityMs = new Date(activeTask.lastActivity).getTime();
  const idleMs = nowMs - lastActivityMs;

  if (idleMs < idleThresholdMs) {
    log.debug("Task not idle long enough", {
      agentId,
      taskId: activeTask.id,
      idleMs,
      thresholdMs: idleThresholdMs,
    });
    return false;
  }

  const state = agentStates.get(agentId);
  
  // Check failure-based backoff first
  if (state?.backoffUntilMs && nowMs < state.backoffUntilMs) {
    const remainingMs = state.backoffUntilMs - nowMs;
    const remainingSec = Math.ceil(remainingMs / 1000);
    log.debug("Continuation backoff active", {
      agentId,
      taskId: activeTask.id,
      remainingSeconds: remainingSec,
      reason: state.lastFailureReason,
      consecutiveFailures: state.consecutiveFailures,
    });
    return false;
  }

  // Check regular cooldown (only for same task, prevents spam on success)
  if (state) {
    const sinceLast = nowMs - state.lastContinuationSentMs;
    if (sinceLast < CONTINUATION_COOLDOWN_MS && state.lastTaskId === activeTask.id && !state.backoffUntilMs) {
      log.debug("Continuation cooldown active", {
        agentId,
        taskId: activeTask.id,
        sinceLast,
        cooldown: CONTINUATION_COOLDOWN_MS,
      });
      return false;
    }
  }

  const pendingTasks = await findPendingTasks(workspaceDir);
  const prompt = formatContinuationPrompt(activeTask, pendingTasks.length);

  log.info("Sending task continuation prompt", {
    agentId,
    taskId: activeTask.id,
    idleMinutes: Math.round(idleMs / 60000),
  });

  try {
    const accountId = resolveAgentBoundAccountId(cfg, agentId, "discord");
    await agentCommand({
      config: cfg,
      message: prompt,
      agentId,
      accountId,
      deliver: false,
      quiet: true,
    });

    // Success - reset failure state
    agentStates.set(agentId, {
      lastContinuationSentMs: nowMs,
      lastTaskId: activeTask.id,
      backoffUntilMs: undefined,
      consecutiveFailures: 0,
      lastFailureReason: undefined,
    });

    log.info("Task continuation prompt sent", { agentId, taskId: activeTask.id });
    return true;
  } catch (error) {
    // Failure - apply backoff based on failure reason
    const { reason, suggestedBackoffMs } = parseFailureReason(error);
    const prevState = agentStates.get(agentId);
    const consecutiveFailures = (prevState?.consecutiveFailures ?? 0) + 1;
    const backoffMs = resolveBackoffMs(reason, consecutiveFailures, suggestedBackoffMs);
    const backoffUntilMs = nowMs + backoffMs;

    agentStates.set(agentId, {
      lastContinuationSentMs: nowMs,
      lastTaskId: activeTask.id,
      backoffUntilMs,
      consecutiveFailures,
      lastFailureReason: reason,
    });

    log.warn("Failed to send continuation prompt, applying backoff", {
      agentId,
      taskId: activeTask.id,
      error: String(error),
      reason,
      consecutiveFailures,
      backoffSeconds: Math.round(backoffMs / 1000),
      suggestedBackoffMs,
    });
    return false;
  }
}

async function checkBlockedTasksForUnblock(
  cfg: OpenClawConfig,
  agentId: string,
  nowMs: number,
): Promise<void> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const blockedTasks = await findBlockedTasks(workspaceDir);

  for (const task of blockedTasks) {
    if (!task.unblockedBy || task.unblockedBy.length === 0) {
      continue;
    }

    const requestCount = task.unblockRequestCount ?? 0;

    // Set escalationState to 'requesting' on first request
    if (requestCount === 0 || task.escalationState === undefined || task.escalationState === 'none') {
      task.escalationState = 'requesting';
    }
    if (requestCount >= MAX_UNBLOCK_REQUESTS) {
      log.debug("Max unblock requests reached", {
        blockedAgentId: agentId,
        taskId: task.id,
        requestCount,
      });
      task.escalationState = 'failed';
      await writeTask(workspaceDir, task);
      continue;
    }

    const lastActivityMs = new Date(task.lastActivity).getTime();
    const sinceLast = nowMs - lastActivityMs;
    if (sinceLast < UNBLOCK_COOLDOWN_MS) {
      log.debug("Unblock cooldown active", {
        blockedAgentId: agentId,
        taskId: task.id,
        sinceLast,
        cooldown: UNBLOCK_COOLDOWN_MS,
      });
      continue;
    }

    const targetAgentId = task.unblockedBy[0];
    const prompt = formatUnblockRequestPrompt(agentId, task);

    log.info("Sending unblock request", {
      blockedAgentId: agentId,
      targetAgentId,
      taskId: task.id,
      requestCount: requestCount + 1,
    });

    try {
      const accountId = resolveAgentBoundAccountId(cfg, targetAgentId, "discord");
      await agentCommand({
        config: cfg,
        message: prompt,
        agentId: targetAgentId,
        accountId,
        deliver: false,
        quiet: true,
      });

      task.unblockRequestCount = requestCount + 1;
      task.lastActivity = new Date().toISOString();
      // Keep escalationState as 'requesting' for subsequent attempts
      if (task.escalationState !== 'requesting') {
        task.escalationState = 'requesting';
      }
      task.progress.push(`[UNBLOCK REQUEST ${task.unblockRequestCount}/${MAX_UNBLOCK_REQUESTS}] Sent to ${targetAgentId}`);
      await writeTask(workspaceDir, task);

      log.info("Unblock request sent", {
        blockedAgentId: agentId,
        targetAgentId,
        taskId: task.id,
        requestCount: task.unblockRequestCount,
      });
    } catch (error) {
      log.warn("Failed to send unblock request", {
        blockedAgentId: agentId,
        targetAgentId,
        taskId: task.id,
        error: String(error),
      });
    }
  }
}

async function runContinuationCheck(cfg: OpenClawConfig, idleThresholdMs: number): Promise<void> {
  const nowMs = Date.now();
  const agentList = cfg.agents?.list ?? [];
  const defaultAgentId = resolveDefaultAgentId(cfg);

  const agentIds = new Set<string>();
  agentIds.add(normalizeAgentId(defaultAgentId));
  for (const entry of agentList) {
    if (entry?.id) {
      agentIds.add(normalizeAgentId(entry.id));
    }
  }

  log.debug("Running task continuation check", { agentCount: agentIds.size });

  for (const agentId of agentIds) {
    try {
      await checkAgentForContinuation(cfg, agentId, idleThresholdMs, nowMs);
      await checkBlockedTasksForUnblock(cfg, agentId, nowMs);
    } catch (error) {
      log.warn("Error checking agent for continuation", { agentId, error: String(error) });
    }
  }
}

export function startTaskContinuationRunner(opts: { cfg: OpenClawConfig }): TaskContinuationRunner {
  let currentCfg = opts.cfg;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;

    const { enabled, checkIntervalMs, idleThresholdMs } = resolveTaskContinuationConfig(currentCfg);

    if (!enabled) {
      log.debug("Task continuation runner disabled");
      return;
    }

    timer = setTimeout(async () => {
      if (stopped) return;

      try {
        await runContinuationCheck(currentCfg, idleThresholdMs);
      } catch (error) {
        log.warn("Task continuation check failed", { error: String(error) });
      }

      scheduleNext();
    }, checkIntervalMs);

    timer.unref?.();
  };

  const { enabled } = resolveTaskContinuationConfig(currentCfg);
  if (enabled) {
    log.info("Task continuation runner started");
    scheduleNext();
  }

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      log.info("Task continuation runner stopped");
    },

    updateConfig: (cfg: OpenClawConfig) => {
      currentCfg = cfg;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!stopped) {
        scheduleNext();
      }
    },

    checkNow: async () => {
      const { idleThresholdMs } = resolveTaskContinuationConfig(currentCfg);
      await runContinuationCheck(currentCfg, idleThresholdMs);
    },
  };
}
