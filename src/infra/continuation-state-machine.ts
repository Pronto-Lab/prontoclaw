/**
 * Continuation State Machine — Pure decision logic for task continuation.
 *
 * Consolidates all continuation decisions from:
 * - task-continuation-runner.ts (polling, zombie detection, backoff, unblock)
 * - task-self-driving.ts (lifecycle end, escalation, consecutive limit)
 * - task-step-continuation.ts (step completion fallback)
 *
 * This module is a PURE FUNCTION layer — no I/O, no side effects.
 * All decisions are based on the input state and return action descriptors.
 */

import type { TaskFile, TaskStep } from "../agents/tools/task-file-io.js";

// ─── Action Types ───

export type ContinuationActionType =
  | "CONTINUE" // Normal continuation — send agent prompt
  | "ESCALATE" // Send escalation prompt (stuck agent)
  | "BACKOFF" // Wait, then retry (rate limit, billing, etc.)
  | "UNBLOCK" // Send unblock request to another agent
  | "ABANDON" // Give up on task (zombie, exceeded reassign limit)
  | "SKIP" // Do nothing this cycle
  | "COMPACT" // Attempt context compaction
  | "BACKLOG_RECOVER"; // Move zombie task to backlog for re-pickup

export interface ContinuationAction {
  type: ContinuationActionType;
  reason: string;
  /** For BACKOFF: how long to wait (ms) */
  delayMs?: number;
  /** For ESCALATE: the prompt to send */
  escalationType?: "stalled_step" | "zero_progress" | "zombie_escalation";
  /** For UNBLOCK: which agent to ask */
  unblockTargetId?: string;
  /** For BACKLOG_RECOVER: reassign count */
  reassignCount?: number;
  /** For BACKOFF: failure classification */
  failureReason?: FailureReason;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ─── Context Types ───

export type ContinuationTrigger = "polling" | "lifecycle_end" | "step_completed";

export interface ContinuationContext {
  trigger: ContinuationTrigger;
  nowMs: number;
}

/** Agent-level state (in-memory, not persisted) */
export interface AgentContinuationState {
  lastContinuationSentMs: number;
  lastTaskId: string | null;
  /** Backoff: skip until this timestamp */
  backoffUntilMs?: number;
  /** Consecutive failures for exponential backoff */
  consecutiveFailures: number;
  /** Last failure reason */
  lastFailureReason?: FailureReason;
}

/** Self-driving loop state */
export interface SelfDrivingState {
  consecutiveCount: number;
  lastContinuationTs: number;
  /** Step-level failure tracking */
  lastStepId?: string;
  sameStepCount: number;
  lastDoneCount: number;
  zeroProgressCount: number;
  escalated: boolean;
}

// ─── Backoff Types ───

export type FailureReason = "rate_limit" | "billing" | "timeout" | "context_overflow" | "unknown";

export interface BackoffStrategy {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  maxAttempts: number;
  onExhausted: "ABANDON" | "ESCALATE";
}

// ─── Constants ───

export const ZOMBIE_TASK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const CONTINUATION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_CONSECUTIVE_SELF_DRIVES = 20;
export const MAX_STALLS_ON_SAME_STEP = 3;
export const MAX_ZERO_PROGRESS_RUNS = 5;
export const MAX_UNBLOCK_REQUESTS = 3;
export const UNBLOCK_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_CONTEXT_OVERFLOW_RETRIES = 5;
export const SELF_DRIVING_GRACE_PERIOD_MS = 1_500;
export const CONTEXT_NEAR_LIMIT_RATIO = 0.8;
export const MAX_ZOMBIE_REASSIGNS = 3;
export const MIN_RATE_LIMIT_BACKOFF_MS = 10_000; // 10 seconds

export const BACKOFF_STRATEGIES: Record<FailureReason, BackoffStrategy> = {
  rate_limit: {
    initialDelayMs: 60_000,
    maxDelayMs: 7_200_000, // 2 hours
    multiplier: 2,
    maxAttempts: 8,
    onExhausted: "ESCALATE",
  },
  billing: {
    initialDelayMs: 3_600_000, // 1 hour
    maxDelayMs: 86_400_000, // 24 hours
    multiplier: 3,
    maxAttempts: 5,
    onExhausted: "ABANDON",
  },
  timeout: {
    initialDelayMs: 60_000,
    maxDelayMs: 600_000, // 10 min
    multiplier: 1.5,
    maxAttempts: 10,
    onExhausted: "ESCALATE",
  },
  context_overflow: {
    initialDelayMs: 1_800_000, // 30 min
    maxDelayMs: 7_200_000, // 2 hours
    multiplier: 2,
    maxAttempts: MAX_CONTEXT_OVERFLOW_RETRIES,
    onExhausted: "ESCALATE",
  },
  unknown: {
    initialDelayMs: 300_000, // 5 min
    maxDelayMs: 7_200_000, // 2 hours
    multiplier: 2,
    maxAttempts: 8,
    onExhausted: "ESCALATE",
  },
};

// ─── Pure Decision Functions ───

/**
 * Calculate backoff delay for a given failure reason and attempt count.
 * Pure function — no side effects.
 */
export function calculateBackoffDelay(
  reason: FailureReason,
  attemptCount: number,
  suggestedBackoffMs?: number,
): number {
  // For rate limits with API-suggested backoff, use it (with minimum)
  if (reason === "rate_limit" && suggestedBackoffMs !== undefined) {
    return Math.max(suggestedBackoffMs, MIN_RATE_LIMIT_BACKOFF_MS);
  }

  const strategy = BACKOFF_STRATEGIES[reason];
  const multiplier = Math.min(Math.pow(strategy.multiplier, Math.max(0, attemptCount - 1)), 8);
  const delay = strategy.initialDelayMs * multiplier;
  return Math.min(delay, strategy.maxDelayMs);
}

/**
 * Parse failure reason from an error message string.
 * Pure function — no side effects.
 */
export function parseFailureReason(errorMessage: string): {
  reason: FailureReason;
  suggestedBackoffMs?: number;
} {
  // Rate limit / quota
  if (/rate.?limit|quota|429|too many requests|all models failed.*rate/i.test(errorMessage)) {
    const match = errorMessage.match(/(?:reset|retry)\s+after\s+(\d+)\s*s(?:econds?)?/i);
    const suggestedBackoffMs = match ? parseInt(match[1], 10) * 1000 : undefined;
    return {
      reason: "rate_limit",
      suggestedBackoffMs:
        suggestedBackoffMs !== undefined && !isNaN(suggestedBackoffMs)
          ? suggestedBackoffMs
          : undefined,
    };
  }

  if (/billing|payment|insufficient|credit/i.test(errorMessage)) {
    return { reason: "billing" };
  }

  if (/timeout|timed out|deadline exceeded/i.test(errorMessage)) {
    return { reason: "timeout" };
  }

  if (/context.*(?:overflow|length.exceeded)|token.*limit|too long|max.*token|prompt is too long|exceeds.*context/i.test(errorMessage)) {
    return { reason: "context_overflow" };
  }

  return { reason: "unknown" };
}

/**
 * Check if a task is a zombie (no activity for > TTL).
 * Pure function.
 */
export function checkZombie(
  task: TaskFile,
  nowMs: number,
  zombieTaskTtlMs: number = ZOMBIE_TASK_TTL_MS,
): { isZombie: boolean; ageMs: number } {
  const lastActivityMs = new Date(task.lastActivity || task.created).getTime();
  if (isNaN(lastActivityMs)) {
    return { isZombie: false, ageMs: 0 };
  }
  const ageMs = nowMs - lastActivityMs;
  return { isZombie: ageMs > zombieTaskTtlMs, ageMs };
}

/**
 * Decide what to do with a zombie task.
 * Pure function.
 */
export function decideZombieAction(
  task: TaskFile,
  ageMs: number,
): ContinuationAction {
  const reassignCount = (task.reassignCount ?? 0) + 1;

  if (reassignCount < MAX_ZOMBIE_REASSIGNS) {
    return {
      type: "BACKLOG_RECOVER",
      reason: `No activity for ${Math.round(ageMs / 3_600_000)}h — moving to backlog (reassign #${reassignCount}/${MAX_ZOMBIE_REASSIGNS})`,
      reassignCount,
    };
  }

  return {
    type: "ABANDON",
    reason: `Exceeded reassign limit of ${MAX_ZOMBIE_REASSIGNS} (inactive ${Math.round(ageMs / 3_600_000)}h) — escalating`,
    reassignCount,
  };
}

/**
 * Decide action for polling trigger (task-continuation-runner logic).
 * Pure function.
 */
export function decidePollingAction(
  task: TaskFile,
  agentState: AgentContinuationState | undefined,
  nowMs: number,
  idleThresholdMs: number,
  isAgentBusy: boolean,
  zombieTaskTtlMs?: number,
): ContinuationAction {
  // 1. Skip completed/cancelled tasks
  if (task.status === "completed" || task.status === "cancelled" || task.status === "abandoned") {
    return { type: "SKIP", reason: `Task status: ${task.status}` };
  }

  // 2. Skip pending_approval tasks
  if (task.status === "pending_approval") {
    return { type: "SKIP", reason: "Task is pending approval" };
  }

  // 3. Agent busy check
  if (isAgentBusy) {
    return { type: "SKIP", reason: "Agent is actively processing" };
  }

  // 4. Zombie check (for in_progress tasks)
  if (task.status === "in_progress") {
    const zombie = checkZombie(task, nowMs, zombieTaskTtlMs);
    if (zombie.isZombie) {
      return decideZombieAction(task, zombie.ageMs);
    }
  }

  // 5. Check failure-based backoff
  if (agentState?.backoffUntilMs && nowMs < agentState.backoffUntilMs) {
    const remainingMs = agentState.backoffUntilMs - nowMs;
    return {
      type: "SKIP",
      reason: `Backoff active: ${agentState.lastFailureReason ?? "unknown"}, ${Math.ceil(remainingMs / 1000)}s remaining`,
    };
  }

  // 6. Regular cooldown (same task, prevents spam)
  if (agentState) {
    const sinceLast = nowMs - agentState.lastContinuationSentMs;
    if (
      sinceLast < CONTINUATION_COOLDOWN_MS &&
      agentState.lastTaskId === task.id &&
      !agentState.backoffUntilMs
    ) {
      return {
        type: "SKIP",
        reason: `Continuation cooldown active (${Math.ceil((CONTINUATION_COOLDOWN_MS - sinceLast) / 1000)}s remaining)`,
      };
    }
  }

  // 7. Idle threshold check (for in_progress tasks)
  if (task.status === "in_progress") {
    const lastActivityMs = new Date(task.lastActivity).getTime();
    const idleMs = nowMs - lastActivityMs;
    if (idleMs < idleThresholdMs) {
      return {
        type: "SKIP",
        reason: `Task not idle long enough (${Math.ceil(idleMs / 1000)}s < ${Math.ceil(idleThresholdMs / 1000)}s threshold)`,
      };
    }
  }

  // 8. Blocked task → unblock
  if (task.status === "blocked") {
    return { type: "UNBLOCK", reason: "Task is blocked" };
  }

  // 9. Normal continuation
  return { type: "CONTINUE", reason: "Task idle, continuation needed" };
}

/**
 * Decide action for self-driving trigger (lifecycle_end).
 * Pure function.
 */
export function decideSelfDrivingAction(
  task: TaskFile,
  selfDriveState: SelfDrivingState,
  isAgentBusy: boolean,
): ContinuationAction {
  // 1. No active task or no steps
  if (!task || task.status !== "in_progress") {
    return { type: "SKIP", reason: "No active in_progress task" };
  }

  if (!task.steps?.length) {
    return { type: "SKIP", reason: "Task has no steps" };
  }

  // 2. All steps done
  const incomplete = task.steps.filter(
    (s) => s.status === "pending" || s.status === "in_progress",
  );
  if (incomplete.length === 0) {
    return { type: "SKIP", reason: "All steps completed" };
  }

  // 3. Agent busy
  if (isAgentBusy) {
    return { type: "SKIP", reason: "Agent has queued messages" };
  }

  // 4. Max consecutive reached
  if (selfDriveState.consecutiveCount >= MAX_CONSECUTIVE_SELF_DRIVES) {
    return {
      type: "SKIP",
      reason: `Max self-driving continuations reached (${MAX_CONSECUTIVE_SELF_DRIVES})`,
    };
  }

  // 5. Escalation: stalled on same step
  if (!selfDriveState.escalated && selfDriveState.sameStepCount >= MAX_STALLS_ON_SAME_STEP) {
    return {
      type: "ESCALATE",
      reason: `Stalled on step "${selfDriveState.lastStepId}" for ${selfDriveState.sameStepCount} consecutive attempts`,
      escalationType: "stalled_step",
    };
  }

  // 6. Escalation: zero progress
  if (!selfDriveState.escalated && selfDriveState.zeroProgressCount >= MAX_ZERO_PROGRESS_RUNS) {
    return {
      type: "ESCALATE",
      reason: `Zero progress for ${selfDriveState.zeroProgressCount} consecutive runs`,
      escalationType: "zero_progress",
    };
  }

  // 7. Normal self-driving continuation
  return { type: "CONTINUE", reason: "Self-driving continuation" };
}

/**
 * Decide action for step-completed trigger (fallback).
 * Pure function.
 */
export function decideStepContinuationAction(
  task: TaskFile,
  isAgentBusy: boolean,
  selfDrivingRecentlyTriggered: boolean,
): ContinuationAction {
  // 1. Self-driving already handled this
  if (selfDrivingRecentlyTriggered) {
    return { type: "SKIP", reason: "Self-driving recently triggered" };
  }

  // 2. No active task
  if (!task || task.status !== "in_progress") {
    return { type: "SKIP", reason: "No active in_progress task" };
  }

  if (!task.steps?.length) {
    return { type: "SKIP", reason: "Task has no steps" };
  }

  // 3. All done
  const incomplete = task.steps.filter(
    (s) => s.status === "pending" || s.status === "in_progress",
  );
  if (incomplete.length === 0) {
    return { type: "SKIP", reason: "All steps completed" };
  }

  // 4. Agent busy
  if (isAgentBusy) {
    return { type: "SKIP", reason: "Agent has queued messages" };
  }

  // 5. Fallback continuation
  return { type: "CONTINUE", reason: "Step continuation fallback" };
}

/**
 * Decide action after a continuation attempt fails.
 * Pure function — returns the backoff action.
 */
export function decideBackoffAction(
  errorMessage: string,
  currentState: AgentContinuationState | undefined,
  nowMs: number,
): { action: ContinuationAction; newState: Partial<AgentContinuationState> } {
  const { reason, suggestedBackoffMs } = parseFailureReason(errorMessage);
  const consecutiveFailures = (currentState?.consecutiveFailures ?? 0) + 1;
  const delayMs = calculateBackoffDelay(reason, consecutiveFailures, suggestedBackoffMs);

  return {
    action: {
      type: "BACKOFF",
      reason: `Failure: ${reason} (attempt ${consecutiveFailures})`,
      delayMs,
      failureReason: reason,
    },
    newState: {
      backoffUntilMs: nowMs + delayMs,
      consecutiveFailures,
      lastFailureReason: reason,
    },
  };
}

/**
 * Update self-driving state with step progress tracking.
 * Pure function — returns the new state (does not mutate).
 */
export function updateSelfDrivingProgress(
  state: SelfDrivingState,
  task: TaskFile,
  nowMs: number,
  cooldownResetMs: number = 60_000,
): SelfDrivingState {
  const newState = { ...state };

  // Reset if cooldown expired
  if (nowMs - state.lastContinuationTs > cooldownResetMs) {
    newState.consecutiveCount = 0;
    newState.sameStepCount = 0;
    newState.zeroProgressCount = 0;
    newState.escalated = false;
  }

  if (!task.steps?.length) {
    return newState;
  }

  const currentStep = task.steps.find((s) => s.status === "in_progress");
  const incomplete = task.steps.filter((s) => s.status === "pending" || s.status === "in_progress");
  const currentStepId = currentStep?.id ?? incomplete[0]?.id;
  const doneCount = task.steps.filter((s) => s.status === "done").length;

  // Track same-step stalls
  if (currentStepId === newState.lastStepId) {
    newState.sameStepCount = newState.sameStepCount + 1;
  } else {
    newState.sameStepCount = 1;
    newState.lastStepId = currentStepId;
    newState.escalated = false; // Reset escalation on step change
  }

  // Track zero-progress runs
  if (doneCount === newState.lastDoneCount) {
    newState.zeroProgressCount = newState.zeroProgressCount + 1;
  } else {
    newState.zeroProgressCount = 0;
    newState.lastDoneCount = doneCount;
  }

  newState.consecutiveCount = newState.consecutiveCount + 1;
  newState.lastContinuationTs = nowMs;

  return newState;
}
