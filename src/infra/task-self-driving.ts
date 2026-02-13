import { onAgentEvent, type AgentEventPayload } from "./agent-events.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { findActiveTask, type TaskFile, type TaskStep } from "../agents/tools/task-tool.js";
import { agentCommand } from "../commands/agent.js";
import { resolveAgentBoundAccountId } from "../routing/bindings.js";
import { getQueueSize } from "../process/command-queue.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawConfig } from "../config/config.js";
import { emit } from "./events/bus.js";
import { EVENT_TYPES } from "./events/schemas.js";

const log = createSubsystemLogger("task-self-driving");

const SELF_DRIVING_DELAY_MS = 500;
const MAX_CONSECUTIVE_CONTINUATIONS = 20;
const COOLDOWN_RESET_MS = 60_000;

interface SelfDrivingState {
  consecutiveCount: number;
  lastContinuationTs: number;
  timer?: ReturnType<typeof setTimeout>;
  lastAttemptSucceeded?: boolean;
}

const agentState = new Map<string, SelfDrivingState>();

function formatSelfDrivingPrompt(
  task: TaskFile,
  incomplete: TaskStep[],
  currentStep: TaskStep | undefined,
  state: SelfDrivingState,
): string {
  const lines = [
    `[SYSTEM — SELF-DRIVING LOOP ${state.consecutiveCount}/${MAX_CONSECUTIVE_CONTINUATIONS}]`,
    ``,
    `Task "${task.description}" — ${incomplete.length} steps remaining:`,
    ``,
  ];

  for (const step of [...task.steps!].sort((a, b) => a.order - b.order)) {
    const marker = step.status === "done" ? "✅"
      : step.status === "in_progress" ? "▶️"
      : step.status === "skipped" ? "⏭️"
      : "⬜";
    lines.push(`${marker} (${step.id}) ${step.content}`);
  }

  lines.push(``);

  if (currentStep) {
    lines.push(`**Continue: ${currentStep.content}**`);
  } else {
    lines.push(`**Start the next pending step.**`);
  }

  lines.push(``);
  lines.push(`Rules:`);
  lines.push(`- Complete the current step, then call task_update(action: "complete_step")`);
  lines.push(`- Proceed immediately to the next step — do NOT stop`);
  lines.push(`- If blocked, call task_update(action: "skip_step") and move on`);
  lines.push(`- Only call task_complete when ALL steps are done`);

  return lines.join("\n");
}

async function checkAndSelfDrive(
  cfg: OpenClawConfig,
  agentId: string,
  state: SelfDrivingState,
): Promise<boolean> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const activeTask = await findActiveTask(workspaceDir);
  if (!activeTask) return false;

  if (activeTask.status !== "in_progress") return false;
  if (!activeTask.steps?.length) return false;

  const incomplete = activeTask.steps.filter(
    s => s.status === "pending" || s.status === "in_progress",
  );
  if (incomplete.length === 0) return false;

  const agentLane = `session:agent:${agentId}:main`;
  const queueSize = getQueueSize(agentLane);
  if (queueSize > 0) {
    log.debug("Agent has queued messages, skipping self-drive", { agentId, queueSize });
    return false;
  }

  state.consecutiveCount++;
  state.lastContinuationTs = Date.now();

  const currentStep = activeTask.steps.find(s => s.status === "in_progress");
  const prompt = formatSelfDrivingPrompt(activeTask, incomplete, currentStep, state);

  log.info("Self-driving continuation", {
    agentId,
    taskId: activeTask.id,
    consecutiveCount: state.consecutiveCount,
    remainingSteps: incomplete.length,
  });

  try {
    const accountId = resolveAgentBoundAccountId(
      cfg,
      agentId,
      cfg.agents?.defaults?.taskContinuation?.channel ?? "discord",
    );
    await agentCommand({
      message: prompt,
      agentId,
      accountId,
      deliver: false,
    });
    state.lastAttemptSucceeded = true;
    return true;
  } catch (error) {
    state.lastAttemptSucceeded = false;
    log.warn("Self-driving continuation failed", { agentId, error: String(error) });
    return false;
  }
}

export type TaskSelfDrivingHandle = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
  didLastAttemptSucceed: (agentId: string) => boolean | undefined;
};

export function startTaskSelfDriving(opts: { cfg: OpenClawConfig }): TaskSelfDrivingHandle {
  let currentCfg = opts.cfg;

  const unsubscribe = onAgentEvent((evt: AgentEventPayload) => {
    if (evt.stream !== "lifecycle") return;

    const phase = evt.data.phase as string;
    const sessionKey = evt.sessionKey;
    if (!sessionKey) return;
    if (isSubagentSessionKey(sessionKey)) return;

    const agentId = resolveAgentIdFromSessionKey(sessionKey);

    if (phase === "start") {
      const state = agentState.get(agentId);
      if (state?.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      return;
    }

    if (phase === "end") {
      const existing = agentState.get(agentId);
      const state: SelfDrivingState = {
        consecutiveCount: existing?.consecutiveCount ?? 0,
        lastContinuationTs: existing?.lastContinuationTs ?? 0,
        lastAttemptSucceeded: existing?.lastAttemptSucceeded,
      };

      if (Date.now() - state.lastContinuationTs > COOLDOWN_RESET_MS) {
        state.consecutiveCount = 0;
      }

      if (state.consecutiveCount >= MAX_CONSECUTIVE_CONTINUATIONS) {
        log.warn("Max self-driving continuations reached", {
          agentId,
          max: MAX_CONSECUTIVE_CONTINUATIONS,
        });
        agentState.set(agentId, state);
        return;
      }

      if (existing?.timer) clearTimeout(existing.timer);

      state.timer = setTimeout(async () => {
        state.timer = undefined;
        await checkAndSelfDrive(currentCfg, agentId, state);
        agentState.set(agentId, state);
      }, SELF_DRIVING_DELAY_MS);

      agentState.set(agentId, state);
    }
  });

  log.info("Task self-driving loop started");

  return {
    stop: () => {
      unsubscribe();
      for (const [, state] of agentState) {
        if (state.timer) {
          clearTimeout(state.timer);
        }
      }
      agentState.clear();
      log.info("Task self-driving loop stopped");
    },
    updateConfig: (cfg: OpenClawConfig) => {
      currentCfg = cfg;
    },
    didLastAttemptSucceed: (agentId: string) => {
      return agentState.get(agentId)?.lastAttemptSucceeded;
    },
  };
}
