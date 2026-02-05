import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { findActiveTask, findPendingTasks, type TaskFile } from "../agents/tools/task-tool.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { agentCommand } from "../commands/agent.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { normalizeAgentId } from "../routing/session-key.js";

const log = createSubsystemLogger("task-continuation");

const DEFAULT_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_IDLE_THRESHOLD_MS = 3 * 60 * 1000;
const CONTINUATION_COOLDOWN_MS = 5 * 60 * 1000;

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
};

const agentStates = new Map<string, AgentContinuationState>();

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

  const mainQueueSize = getQueueSize(CommandLane.Main);
  if (mainQueueSize > 0) {
    log.debug({ agentId, queueSize: mainQueueSize }, "Agent busy, skipping continuation check");
    return false;
  }

  const activeTask = await findActiveTask(workspaceDir);
  if (!activeTask) {
    agentStates.delete(agentId);
    return false;
  }

  const lastActivityMs = new Date(activeTask.lastActivity).getTime();
  const idleMs = nowMs - lastActivityMs;

  if (idleMs < idleThresholdMs) {
    log.debug(
      { agentId, taskId: activeTask.id, idleMs, thresholdMs: idleThresholdMs },
      "Task not idle long enough",
    );
    return false;
  }

  const state = agentStates.get(agentId);
  if (state) {
    const sinceLast = nowMs - state.lastContinuationSentMs;
    if (sinceLast < CONTINUATION_COOLDOWN_MS && state.lastTaskId === activeTask.id) {
      log.debug(
        { agentId, taskId: activeTask.id, sinceLast, cooldown: CONTINUATION_COOLDOWN_MS },
        "Continuation cooldown active",
      );
      return false;
    }
  }

  const pendingTasks = await findPendingTasks(workspaceDir);
  const prompt = formatContinuationPrompt(activeTask, pendingTasks.length);

  log.info(
    { agentId, taskId: activeTask.id, idleMinutes: Math.round(idleMs / 60000) },
    "Sending task continuation prompt",
  );

  try {
    await agentCommand({
      config: cfg,
      message: prompt,
      agentId,
      deliver: false,
      quiet: true,
    });

    agentStates.set(agentId, {
      lastContinuationSentMs: nowMs,
      lastTaskId: activeTask.id,
    });

    log.info({ agentId, taskId: activeTask.id }, "Task continuation prompt sent");
    return true;
  } catch (error) {
    log.warn(
      { agentId, taskId: activeTask.id, error: String(error) },
      "Failed to send continuation prompt",
    );
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

  log.debug({ agentCount: agentIds.size }, "Running task continuation check");

  for (const agentId of agentIds) {
    try {
      await checkAgentForContinuation(cfg, agentId, idleThresholdMs, nowMs);
    } catch (error) {
      log.warn({ agentId, error: String(error) }, "Error checking agent for continuation");
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
        log.warn({ error: String(error) }, "Task continuation check failed");
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
