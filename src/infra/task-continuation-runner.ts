import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { findActiveTask, findPendingTasks, type TaskFile } from "../agents/tools/task-tool.js";
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

// Failure-based backoff configuration
const BACKOFF_MS = {
  rate_limit: 20 * 60 * 1000,    // 20 minutes
  billing: 60 * 60 * 1000,       // 1 hour
  timeout: 1 * 60 * 1000,        // 1 minute
  context_overflow: 30 * 60 * 1000, // 30 minutes (needs manual intervention)
  unknown: 5 * 60 * 1000,        // 5 minutes (default)
} as const;

type FailureReason = keyof typeof BACKOFF_MS;

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
 * Parse failure reason from error message.
 * Returns a categorized reason for backoff calculation.
 */
function parseFailureReason(error: unknown): FailureReason {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  // Rate limit / quota exhaustion
  if (
    /rate.?limit|quota|429|too many requests|all models failed.*rate/i.test(message)
  ) {
    return "rate_limit";
  }

  // Billing / payment issues
  if (/billing|payment|insufficient|credit/i.test(message)) {
    return "billing";
  }

  // Timeout
  if (/timeout|timed out|deadline exceeded/i.test(message)) {
    return "timeout";
  }

  // Context overflow
  if (/context.*overflow|token.*limit|too long|max.*token/i.test(message)) {
    return "context_overflow";
  }

  return "unknown";
}

/**
 * Calculate backoff duration based on failure reason and consecutive failures.
 * Uses exponential backoff with a cap.
 */
function resolveBackoffMs(reason: FailureReason, consecutiveFailures: number): number {
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

  if (activeTask.status === "pending_approval") {
    log.debug("Task is pending approval, skipping continuation", {
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
    const remainingMin = Math.ceil(remainingMs / 60000);
    log.debug("Continuation backoff active", {
      agentId,
      taskId: activeTask.id,
      remainingMinutes: remainingMin,
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
    const reason = parseFailureReason(error);
    const prevState = agentStates.get(agentId);
    const consecutiveFailures = (prevState?.consecutiveFailures ?? 0) + 1;
    const backoffMs = resolveBackoffMs(reason, consecutiveFailures);
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
      backoffMinutes: Math.round(backoffMs / 60000),
    });
    return false;
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
