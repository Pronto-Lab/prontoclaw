import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { findActiveTask, type TaskFile, type TaskStep } from "../agents/tools/task-tool.js";
import { agentCommand } from "../commands/agent.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueSize } from "../process/command-queue.js";
import { resolveAgentBoundAccountId } from "../routing/bindings.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { onAgentEvent, type AgentEventPayload } from "./agent-events.js";

const log = createSubsystemLogger("task-self-driving");

const SELF_DRIVING_DELAY_MS = 500;
const MAX_CONSECUTIVE_CONTINUATIONS = 50;
const COOLDOWN_RESET_MS = 60_000;
// [PRONTO-CUSTOM] Failure detection: track stalled steps
const MAX_STALLS_ON_SAME_STEP = 3;
const MAX_ZERO_PROGRESS_RUNS = 5;
const ESCALATION_RE_INTERVAL = 5;
const MAX_STEPS_MISSING_PROMPTS = 3;

interface SelfDrivingState {
  consecutiveCount: number;
  lastContinuationTs: number;
  timer?: ReturnType<typeof setTimeout>;
  lastAttemptSucceeded?: boolean;
  // [PRONTO-CUSTOM] Failure tracking
  lastStepId?: string;
  sameStepCount: number;
  lastDoneCount: number;
  zeroProgressCount: number;
  stepsMissingCount: number;
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

  for (const step of [...task.steps!].toSorted((a, b) => a.order - b.order)) {
    const marker =
      step.status === "done"
        ? "✅"
        : step.status === "in_progress"
          ? "▶️"
          : step.status === "skipped"
            ? "⏭️"
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

// [PRONTO-CUSTOM] Escalation prompt when stuck on same step or zero progress
function formatEscalationPrompt(
  task: TaskFile,
  state: SelfDrivingState,
  reason: "stalled_step" | "zero_progress",
): string {
  const lines = [`[SYSTEM — SELF-DRIVING ESCALATION]`, ``];

  if (reason === "stalled_step") {
    lines.push(
      `⚠️ Self-driving loop has been stuck on step "${state.lastStepId}" for ${state.sameStepCount} consecutive attempts.`,
    );
    lines.push(``);
    lines.push(`Choose ONE of these actions:`);
    lines.push(`A. **Fix directly**: Identify why this step is failing and fix it yourself`);
    lines.push(
      `B. **Consult**: Spawn consultant sub-agent for architecture advice — sessions_spawn(agentId: "consultant", task: "...")`,
    );
    lines.push(
      `C. **Report to user**: If truly blocked, explain the situation and ask for guidance`,
    );
    lines.push(``);
    lines.push(
      `If the step is genuinely impossible, skip it: task_update(action: "skip_step", step_id: "${state.lastStepId}")`,
    );
  } else {
    lines.push(
      `⚠️ Self-driving loop has run ${state.zeroProgressCount} times with ZERO step progress.`,
    );
    lines.push(``);
    lines.push(`This suggests a systemic issue. Choose ONE:`);
    lines.push(`A. **Fix directly**: Review task steps and fix the blocking issue`);
    lines.push(
      `B. **Consult**: sessions_spawn(agentId: "consultant", task: "Analyze why task steps are not progressing")`,
    );
    lines.push(`C. **Report to user**: Explain the situation honestly and ask for help`);
  }

  lines.push(``);
  lines.push(`Current task: "${task.description}"`);
  if (task.steps) {
    for (const step of [...task.steps].toSorted((a, b) => a.order - b.order)) {
      const marker =
        step.status === "done"
          ? "✅"
          : step.status === "in_progress"
            ? "▶️"
            : step.status === "skipped"
              ? "⏭️"
              : "⬜";
      lines.push(`${marker} (${step.id}) ${step.content}`);
    }
  }

  return lines.join("\n");
}

function formatStepsMissingPrompt(task: TaskFile, attempt: number): string {
  const lines = [
    `[SYSTEM — STEPS REQUIRED (${attempt}/${MAX_STEPS_MISSING_PROMPTS})]`,
    ``,
    `Task "${task.description}" is NOT marked as simple but has NO steps defined.`,
    ``,
    `You MUST define steps for this task using task_update(action: "set_steps", steps: [...]).`,
    ``,
    `Example:`,
    `task_update({`,
    `  action: "set_steps",`,
    `  steps: [`,
    `    { content: "Analyze current code" },`,
    `    { content: "Implement changes" },`,
    `    { content: "Test and verify" }`,
    `  ]`,
    `})`,
    ``,
    `Steps provide visibility into your progress through Task Hub.`,
    `Define 2-6 concrete steps that cover the work needed.`,
  ];

  return lines.join("\n");
}

async function checkAndSelfDrive(
  cfg: OpenClawConfig,
  agentId: string,
  state: SelfDrivingState,
): Promise<boolean> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const activeTask = await findActiveTask(workspaceDir);
  if (!activeTask) {
    return false;
  }

  if (activeTask.status !== "in_progress") {
    return false;
  }
  if (!activeTask.steps?.length) {
    if (activeTask.simple) {
      return false;
    }
    if (state.stepsMissingCount >= MAX_STEPS_MISSING_PROMPTS) {
      log.debug("Max steps-missing prompts reached, skipping", { agentId });
      return false;
    }
    state.stepsMissingCount++;
    state.consecutiveCount++;
    state.lastContinuationTs = Date.now();

    const prompt = formatStepsMissingPrompt(activeTask, state.stepsMissingCount);
    log.info("Prompting agent to define steps", {
      agentId,
      taskId: activeTask.id,
      stepsMissingCount: state.stepsMissingCount,
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
      log.warn("Steps-missing prompt failed", { agentId, error: String(error) });
      return false;
    }
  }

  const incomplete = activeTask.steps.filter(
    (s) => s.status === "pending" || s.status === "in_progress",
  );
  if (incomplete.length === 0) {
    return false;
  }

  const agentLane = `session:agent:${agentId}:main`;
  const queueSize = getQueueSize(agentLane);
  if (queueSize > 0) {
    log.debug("Agent has queued messages, skipping self-drive", { agentId, queueSize });
    return false;
  }

  // [PRONTO-CUSTOM] Failure detection: track step progress
  const currentStep = activeTask.steps.find((s) => s.status === "in_progress");
  const currentStepId = currentStep?.id ?? incomplete[0]?.id;
  const doneCount = activeTask.steps.filter((s) => s.status === "done").length;

  // Track same-step stalls
  if (currentStepId === state.lastStepId) {
    state.sameStepCount++;
  } else {
    state.sameStepCount = 1;
    state.lastStepId = currentStepId;
  }

  // Track zero-progress runs
  if (doneCount === state.lastDoneCount) {
    state.zeroProgressCount++;
  } else {
    state.zeroProgressCount = 0;
    state.lastDoneCount = doneCount;
  }

  state.consecutiveCount++;
  state.lastContinuationTs = Date.now();

  let prompt: string;
  const shouldEscalateStalled =
    state.sameStepCount >= MAX_STALLS_ON_SAME_STEP &&
    (state.sameStepCount === MAX_STALLS_ON_SAME_STEP ||
      (state.sameStepCount - MAX_STALLS_ON_SAME_STEP) % ESCALATION_RE_INTERVAL === 0);
  const shouldEscalateZero =
    state.zeroProgressCount >= MAX_ZERO_PROGRESS_RUNS &&
    (state.zeroProgressCount === MAX_ZERO_PROGRESS_RUNS ||
      (state.zeroProgressCount - MAX_ZERO_PROGRESS_RUNS) % ESCALATION_RE_INTERVAL === 0);

  if (shouldEscalateStalled) {
    log.warn("Self-driving escalation: stalled on same step", {
      agentId,
      stepId: currentStepId,
      sameStepCount: state.sameStepCount,
    });
    prompt = formatEscalationPrompt(activeTask, state, "stalled_step");
  } else if (shouldEscalateZero) {
    log.warn("Self-driving escalation: zero progress", {
      agentId,
      zeroProgressCount: state.zeroProgressCount,
    });
    prompt = formatEscalationPrompt(activeTask, state, "zero_progress");
  } else {
    prompt = formatSelfDrivingPrompt(activeTask, incomplete, currentStep, state);
  }

  log.info("Self-driving continuation", {
    agentId,
    taskId: activeTask.id,
    consecutiveCount: state.consecutiveCount,
    remainingSteps: incomplete.length,
    sameStepCount: state.sameStepCount,
    zeroProgressCount: state.zeroProgressCount,
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
  getLastContinuationTs: (agentId: string) => number;
};

export function startTaskSelfDriving(opts: { cfg: OpenClawConfig }): TaskSelfDrivingHandle {
  let currentCfg = opts.cfg;

  const unsubscribe = onAgentEvent((evt: AgentEventPayload) => {
    if (evt.stream !== "lifecycle") {
      return;
    }

    const phase = evt.data.phase as string;
    const sessionKey = evt.sessionKey;
    if (!sessionKey) {
      return;
    }
    if (isSubagentSessionKey(sessionKey)) {
      return;
    }

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
        // Preserve failure tracking state
        lastStepId: existing?.lastStepId,
        sameStepCount: existing?.sameStepCount ?? 0,
        lastDoneCount: existing?.lastDoneCount ?? 0,
        zeroProgressCount: existing?.zeroProgressCount ?? 0,
        stepsMissingCount: existing?.stepsMissingCount ?? 0,
      };

      if (Date.now() - state.lastContinuationTs > COOLDOWN_RESET_MS) {
        state.consecutiveCount = 0;
        // Also reset failure tracking on cooldown
        state.sameStepCount = 0;
        state.zeroProgressCount = 0;
        state.stepsMissingCount = 0;
      }

      if (state.consecutiveCount >= MAX_CONSECUTIVE_CONTINUATIONS) {
        log.warn("Max self-driving continuations reached", {
          agentId,
          max: MAX_CONSECUTIVE_CONTINUATIONS,
        });
        agentState.set(agentId, state);
        return;
      }

      if (existing?.timer) {
        clearTimeout(existing.timer);
      }

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
    // [PRONTO-CUSTOM] Expose last continuation timestamp for race condition prevention
    getLastContinuationTs: (agentId: string) => {
      return agentState.get(agentId)?.lastContinuationTs ?? 0;
    },
  };
}
