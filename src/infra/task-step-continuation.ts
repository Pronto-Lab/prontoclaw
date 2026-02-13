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

const log = createSubsystemLogger("task-step-continuation");

const CONTINUATION_DELAY_MS = 2_000;
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function formatStepContinuationPrompt(
  task: TaskFile,
  incomplete: TaskStep[],
  currentStep: TaskStep | undefined,
): string {
  const lines = [
    `[SYSTEM REMINDER - STEP CONTINUATION]`,
    ``,
    `Task "${task.description}" has incomplete steps:`,
    ``,
  ];

  for (const step of [...task.steps!].sort((a, b) => a.order - b.order)) {
    const marker = step.status === "done" ? "✅"
      : step.status === "in_progress" ? "▶"
      : step.status === "skipped" ? "⏭"
      : "□";
    lines.push(`${marker} (${step.id}) ${step.content}`);
  }

  lines.push(``);

  if (currentStep) {
    lines.push(`Continue from: **${currentStep.content}**`);
  } else {
    lines.push(`Start the next pending step.`);
  }

  lines.push(``);
  lines.push(`Use task_update(action: "complete_step", step_id: "...") when each step is done.`);
  lines.push(`Do NOT call task_complete until all steps are done.`);

  return lines.join("\n");
}

async function checkAndContinue(cfg: OpenClawConfig, agentId: string): Promise<void> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const activeTask = await findActiveTask(workspaceDir);
  if (!activeTask) return;

  if (activeTask.status !== "in_progress") return;
  if (!activeTask.steps?.length) return;

  const incomplete = activeTask.steps.filter(
    s => s.status === "pending" || s.status === "in_progress",
  );
  if (incomplete.length === 0) return;

  const agentLane = `session:agent:${agentId}:main`;
  const queueSize = getQueueSize(agentLane);
  if (queueSize > 0) {
    log.debug("Agent has queued messages, skipping step continuation", { agentId, queueSize });
    return;
  }

  const currentStep = activeTask.steps.find(s => s.status === "in_progress");
  const prompt = formatStepContinuationPrompt(activeTask, incomplete, currentStep);

  log.info("Step continuation triggered (fallback)", {
    agentId,
    taskId: activeTask.id,
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
  } catch (error) {
    log.warn("Step continuation failed", { agentId, error: String(error) });
  }
}

export type TaskStepContinuationHandle = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};

export function startTaskStepContinuation(opts: { cfg: OpenClawConfig }): TaskStepContinuationHandle {
  let currentCfg = opts.cfg;

  const unsubscribe = onAgentEvent((evt: AgentEventPayload) => {
    if (evt.stream !== "lifecycle") return;

    const phase = evt.data.phase as string;
    const sessionKey = evt.sessionKey;
    if (!sessionKey) return;
    if (isSubagentSessionKey(sessionKey)) return;

    const agentId = resolveAgentIdFromSessionKey(sessionKey);

    if (phase === "start") {
      const existing = pendingTimers.get(agentId);
      if (existing) {
        clearTimeout(existing);
        pendingTimers.delete(agentId);
      }
      return;
    }

    if (phase === "end") {
      const existing = pendingTimers.get(agentId);
      if (existing) clearTimeout(existing);

      pendingTimers.set(agentId, setTimeout(async () => {
        pendingTimers.delete(agentId);
        await checkAndContinue(currentCfg, agentId);
      }, CONTINUATION_DELAY_MS));
    }
  });

  log.info("Task step continuation started");

  return {
    stop: () => {
      unsubscribe();
      for (const [, timer] of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      log.info("Task step continuation stopped");
    },
    updateConfig: (cfg: OpenClawConfig) => {
      currentCfg = cfg;
    },
  };
}
