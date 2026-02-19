import { describe, it, expect } from "vitest";
import type { TaskFile } from "../agents/tools/task-file-io.js";
import {
  calculateBackoffDelay,
  parseFailureReason,
  checkZombie,
  decideZombieAction,
  decidePollingAction,
  decideSelfDrivingAction,
  decideStepContinuationAction,
  decideBackoffAction,
  updateSelfDrivingProgress,
  ZOMBIE_TASK_TTL_MS,
  CONTINUATION_COOLDOWN_MS,
  MAX_CONSECUTIVE_SELF_DRIVES,
  MAX_STALLS_ON_SAME_STEP,
  MAX_ZERO_PROGRESS_RUNS,
  MAX_ZOMBIE_REASSIGNS,
  type AgentContinuationState,
  type SelfDrivingState,
} from "./continuation-state-machine.js";

// ─── Test Helpers ───

function makeTask(overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    id: "task_test_1",
    description: "Test task",
    status: "in_progress",
    priority: "medium",
    assignee: "test-agent",
    created: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    progress: [],
    steps: [],
    ...overrides,
  } as TaskFile;
}

function makeAgentState(overrides: Partial<AgentContinuationState> = {}): AgentContinuationState {
  return {
    lastContinuationSentMs: 0,
    lastTaskId: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function makeSelfDrivingState(overrides: Partial<SelfDrivingState> = {}): SelfDrivingState {
  return {
    consecutiveCount: 0,
    lastContinuationTs: 0,
    sameStepCount: 0,
    lastDoneCount: 0,
    zeroProgressCount: 0,
    escalated: false,
    ...overrides,
  };
}

function makeSteps(specs: Array<{ id: string; status: string; order?: number }>): any[] {
  return specs.map((s, i) => ({
    id: s.id,
    content: `Step ${s.id}`,
    status: s.status,
    order: s.order ?? i + 1,
  }));
}

const NOW = Date.now();

// ─── calculateBackoffDelay ───

describe("calculateBackoffDelay", () => {
  it("rate_limit first attempt: 1 minute", () => {
    expect(calculateBackoffDelay("rate_limit", 0)).toBe(60_000);
  });

  it("rate_limit second attempt: 2 minutes (2x)", () => {
    expect(calculateBackoffDelay("rate_limit", 1)).toBe(60_000); // 60000 * 2^0 = 60000
  });

  it("rate_limit third attempt: doubled", () => {
    expect(calculateBackoffDelay("rate_limit", 2)).toBe(120_000); // 60000 * 2^1
  });

  it("caps at max delay", () => {
    const result = calculateBackoffDelay("rate_limit", 100);
    expect(result).toBeLessThanOrEqual(7_200_000);
  });

  it("uses suggested backoff for rate_limit when provided", () => {
    expect(calculateBackoffDelay("rate_limit", 0, 30_000)).toBe(30_000);
  });

  it("enforces minimum backoff for rate_limit suggestions", () => {
    expect(calculateBackoffDelay("rate_limit", 0, 1_000)).toBe(10_000); // MIN = 10s
  });

  it("billing first attempt: 1 hour", () => {
    expect(calculateBackoffDelay("billing", 0)).toBe(3_600_000);
  });

  it("timeout first attempt: 1 minute", () => {
    expect(calculateBackoffDelay("timeout", 0)).toBe(60_000);
  });

  it("context_overflow first attempt: 30 minutes", () => {
    expect(calculateBackoffDelay("context_overflow", 0)).toBe(1_800_000);
  });

  it("unknown first attempt: 5 minutes", () => {
    expect(calculateBackoffDelay("unknown", 0)).toBe(300_000);
  });
});

// ─── parseFailureReason ───

describe("parseFailureReason", () => {
  it("detects rate limit", () => {
    expect(parseFailureReason("429 Too Many Requests").reason).toBe("rate_limit");
  });

  it("detects rate limit with reset time", () => {
    const result = parseFailureReason("rate limit exceeded, reset after 30s");
    expect(result.reason).toBe("rate_limit");
    expect(result.suggestedBackoffMs).toBe(30_000);
  });

  it("detects billing", () => {
    expect(parseFailureReason("billing account issue").reason).toBe("billing");
  });

  it("detects timeout", () => {
    expect(parseFailureReason("request timed out").reason).toBe("timeout");
  });

  it("detects context overflow", () => {
    expect(parseFailureReason("context length exceeded").reason).toBe("context_overflow");
  });

  it("returns unknown for unrecognized errors", () => {
    expect(parseFailureReason("some random error").reason).toBe("unknown");
  });
});

// ─── checkZombie ───

describe("checkZombie", () => {
  it("24h+ inactive → zombie", () => {
    const task = makeTask({
      lastActivity: new Date(NOW - 25 * 60 * 60 * 1000).toISOString(),
    });
    const result = checkZombie(task, NOW);
    expect(result.isZombie).toBe(true);
    expect(result.ageMs).toBeGreaterThan(ZOMBIE_TASK_TTL_MS);
  });

  it("23h59m → not zombie", () => {
    const task = makeTask({
      lastActivity: new Date(NOW - 23.98 * 60 * 60 * 1000).toISOString(),
    });
    const result = checkZombie(task, NOW);
    expect(result.isZombie).toBe(false);
  });

  it("falls back to created date if no lastActivity", () => {
    const task = makeTask({
      lastActivity: "",
      created: new Date(NOW - 25 * 60 * 60 * 1000).toISOString(),
    });
    const result = checkZombie(task, NOW);
    expect(result.isZombie).toBe(true);
  });

  it("respects custom TTL", () => {
    const task = makeTask({
      lastActivity: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    });
    const result = checkZombie(task, NOW, 1 * 60 * 60 * 1000); // 1h TTL
    expect(result.isZombie).toBe(true);
  });
});

// ─── decideZombieAction ───

describe("decideZombieAction", () => {
  it("first zombie → BACKLOG_RECOVER", () => {
    const task = makeTask({ reassignCount: 0 });
    const action = decideZombieAction(task, 25 * 60 * 60 * 1000);
    expect(action.type).toBe("BACKLOG_RECOVER");
    expect(action.reassignCount).toBe(1);
  });

  it("reassign count 2 → BACKLOG_RECOVER", () => {
    const task = makeTask({ reassignCount: 1 } as any);
    const action = decideZombieAction(task, 25 * 60 * 60 * 1000);
    expect(action.type).toBe("BACKLOG_RECOVER");
    expect(action.reassignCount).toBe(2);
  });

  it("max reassigns exceeded → ABANDON", () => {
    const task = makeTask({ reassignCount: MAX_ZOMBIE_REASSIGNS - 1 } as any);
    const action = decideZombieAction(task, 25 * 60 * 60 * 1000);
    expect(action.type).toBe("ABANDON");
  });
});

// ─── decidePollingAction ───

describe("decidePollingAction", () => {
  it("completed task → SKIP", () => {
    const task = makeTask({ status: "completed" });
    const action = decidePollingAction(task, undefined, NOW, 180_000, false);
    expect(action.type).toBe("SKIP");
  });

  it("pending_approval → SKIP", () => {
    const task = makeTask({ status: "pending_approval" as any });
    const action = decidePollingAction(task, undefined, NOW, 180_000, false);
    expect(action.type).toBe("SKIP");
  });

  it("agent busy → SKIP", () => {
    const task = makeTask();
    const action = decidePollingAction(task, undefined, NOW, 180_000, true);
    expect(action.type).toBe("SKIP");
    expect(action.reason).toContain("actively processing");
  });

  it("zombie task → BACKLOG_RECOVER or ABANDON", () => {
    const task = makeTask({
      lastActivity: new Date(NOW - 25 * 60 * 60 * 1000).toISOString(),
    });
    const action = decidePollingAction(task, undefined, NOW, 180_000, false);
    expect(["BACKLOG_RECOVER", "ABANDON"]).toContain(action.type);
  });

  it("backoff active → SKIP", () => {
    const state = makeAgentState({
      backoffUntilMs: NOW + 60_000,
      lastFailureReason: "rate_limit",
    });
    const task = makeTask({
      lastActivity: new Date(NOW - 300_000).toISOString(),
    });
    const action = decidePollingAction(task, state, NOW, 180_000, false);
    expect(action.type).toBe("SKIP");
    expect(action.reason).toContain("Backoff active");
  });

  it("expired backoff → CONTINUE", () => {
    const state = makeAgentState({
      backoffUntilMs: NOW - 1000,
      lastContinuationSentMs: NOW - CONTINUATION_COOLDOWN_MS - 1000,
    });
    const task = makeTask({
      lastActivity: new Date(NOW - 300_000).toISOString(),
    });
    const action = decidePollingAction(task, state, NOW, 180_000, false);
    expect(action.type).toBe("CONTINUE");
  });

  it("cooldown active for same task → SKIP", () => {
    const state = makeAgentState({
      lastContinuationSentMs: NOW - 60_000, // 1 min ago (< 5 min cooldown)
      lastTaskId: "task_test_1",
    });
    const task = makeTask({
      lastActivity: new Date(NOW - 300_000).toISOString(),
    });
    const action = decidePollingAction(task, state, NOW, 180_000, false);
    expect(action.type).toBe("SKIP");
    expect(action.reason).toContain("cooldown");
  });

  it("not idle long enough → SKIP", () => {
    const task = makeTask({
      lastActivity: new Date(NOW - 60_000).toISOString(), // 1 min idle
    });
    const action = decidePollingAction(task, undefined, NOW, 180_000, false); // 3 min threshold
    expect(action.type).toBe("SKIP");
    expect(action.reason).toContain("not idle");
  });

  it("blocked task → UNBLOCK", () => {
    const task = makeTask({ status: "blocked" });
    const action = decidePollingAction(task, undefined, NOW, 180_000, false);
    expect(action.type).toBe("UNBLOCK");
  });

  it("idle in_progress task → CONTINUE", () => {
    const task = makeTask({
      lastActivity: new Date(NOW - 300_000).toISOString(), // 5 min idle
    });
    const action = decidePollingAction(task, undefined, NOW, 180_000, false); // 3 min threshold
    expect(action.type).toBe("CONTINUE");
  });
});

// ─── decideSelfDrivingAction ───

describe("decideSelfDrivingAction", () => {
  it("no task → SKIP", () => {
    const task = makeTask({ status: "completed" });
    const state = makeSelfDrivingState();
    expect(decideSelfDrivingAction(task, state, false).type).toBe("SKIP");
  });

  it("no steps → SKIP", () => {
    const task = makeTask({ steps: [] });
    const state = makeSelfDrivingState();
    expect(decideSelfDrivingAction(task, state, false).type).toBe("SKIP");
  });

  it("all steps done → SKIP", () => {
    const task = makeTask({
      steps: makeSteps([{ id: "s1", status: "done" }]),
    });
    const state = makeSelfDrivingState();
    expect(decideSelfDrivingAction(task, state, false).type).toBe("SKIP");
  });

  it("agent busy → SKIP", () => {
    const task = makeTask({
      steps: makeSteps([{ id: "s1", status: "pending" }]),
    });
    const state = makeSelfDrivingState();
    expect(decideSelfDrivingAction(task, state, true).type).toBe("SKIP");
  });

  it("max consecutive reached → SKIP", () => {
    const task = makeTask({
      steps: makeSteps([{ id: "s1", status: "pending" }]),
    });
    const state = makeSelfDrivingState({ consecutiveCount: MAX_CONSECUTIVE_SELF_DRIVES });
    expect(decideSelfDrivingAction(task, state, false).type).toBe("SKIP");
  });

  it("stalled on same step → ESCALATE", () => {
    const task = makeTask({
      steps: makeSteps([{ id: "s1", status: "in_progress" }]),
    });
    const state = makeSelfDrivingState({
      sameStepCount: MAX_STALLS_ON_SAME_STEP,
      lastStepId: "s1",
    });
    const action = decideSelfDrivingAction(task, state, false);
    expect(action.type).toBe("ESCALATE");
    expect(action.escalationType).toBe("stalled_step");
  });

  it("zero progress → ESCALATE", () => {
    const task = makeTask({
      steps: makeSteps([{ id: "s1", status: "pending" }]),
    });
    const state = makeSelfDrivingState({
      zeroProgressCount: MAX_ZERO_PROGRESS_RUNS,
    });
    const action = decideSelfDrivingAction(task, state, false);
    expect(action.type).toBe("ESCALATE");
    expect(action.escalationType).toBe("zero_progress");
  });

  it("already escalated → CONTINUE (not double escalate)", () => {
    const task = makeTask({
      steps: makeSteps([{ id: "s1", status: "in_progress" }]),
    });
    const state = makeSelfDrivingState({
      sameStepCount: MAX_STALLS_ON_SAME_STEP + 1,
      lastStepId: "s1",
      escalated: true,
    });
    expect(decideSelfDrivingAction(task, state, false).type).toBe("CONTINUE");
  });

  it("normal → CONTINUE", () => {
    const task = makeTask({
      steps: makeSteps([
        { id: "s1", status: "done" },
        { id: "s2", status: "pending" },
      ]),
    });
    const state = makeSelfDrivingState();
    expect(decideSelfDrivingAction(task, state, false).type).toBe("CONTINUE");
  });
});

// ─── decideStepContinuationAction ───

describe("decideStepContinuationAction", () => {
  it("self-driving recently triggered → SKIP", () => {
    const task = makeTask({
      steps: makeSteps([{ id: "s1", status: "pending" }]),
    });
    expect(decideStepContinuationAction(task, false, true).type).toBe("SKIP");
  });

  it("no task → SKIP", () => {
    const task = makeTask({ status: "completed" });
    expect(decideStepContinuationAction(task, false, false).type).toBe("SKIP");
  });

  it("all steps done → SKIP", () => {
    const task = makeTask({
      steps: makeSteps([{ id: "s1", status: "done" }]),
    });
    expect(decideStepContinuationAction(task, false, false).type).toBe("SKIP");
  });

  it("agent busy → SKIP", () => {
    const task = makeTask({
      steps: makeSteps([{ id: "s1", status: "pending" }]),
    });
    expect(decideStepContinuationAction(task, true, false).type).toBe("SKIP");
  });

  it("normal → CONTINUE", () => {
    const task = makeTask({
      steps: makeSteps([{ id: "s1", status: "pending" }]),
    });
    expect(decideStepContinuationAction(task, false, false).type).toBe("CONTINUE");
  });
});

// ─── decideBackoffAction ───

describe("decideBackoffAction", () => {
  it("rate_limit → BACKOFF with 1min+ delay", () => {
    const result = decideBackoffAction("429 Too Many Requests", undefined, NOW);
    expect(result.action.type).toBe("BACKOFF");
    expect(result.action.delayMs).toBeGreaterThanOrEqual(10_000);
    expect(result.action.failureReason).toBe("rate_limit");
    expect(result.newState.consecutiveFailures).toBe(1);
    expect(result.newState.backoffUntilMs).toBeGreaterThan(NOW);
  });

  it("consecutive failures increase backoff", () => {
    const state = makeAgentState({ consecutiveFailures: 3 });
    const result = decideBackoffAction("timeout", state, NOW);
    expect(result.newState.consecutiveFailures).toBe(4);
    expect(result.action.delayMs).toBeGreaterThan(60_000); // > initial
  });

  it("rate_limit with suggested backoff", () => {
    const result = decideBackoffAction("rate limit, reset after 45s", undefined, NOW);
    expect(result.action.delayMs).toBe(45_000);
  });
});

// ─── updateSelfDrivingProgress ───

describe("updateSelfDrivingProgress", () => {
  it("increments consecutiveCount", () => {
    const state = makeSelfDrivingState({ consecutiveCount: 5, lastContinuationTs: NOW - 10_000 });
    const task = makeTask({ steps: makeSteps([{ id: "s1", status: "pending" }]) });
    const newState = updateSelfDrivingProgress(state, task, NOW);
    expect(newState.consecutiveCount).toBe(6);
  });

  it("tracks same-step stalls", () => {
    const state = makeSelfDrivingState({ lastStepId: "s1", sameStepCount: 2, lastContinuationTs: NOW - 10_000 });
    const task = makeTask({ steps: makeSteps([{ id: "s1", status: "in_progress" }]) });
    const newState = updateSelfDrivingProgress(state, task, NOW);
    expect(newState.sameStepCount).toBe(3);
  });

  it("resets same-step count on step change", () => {
    const state = makeSelfDrivingState({ lastStepId: "s1", sameStepCount: 5, escalated: true });
    const task = makeTask({
      steps: makeSteps([
        { id: "s1", status: "done" },
        { id: "s2", status: "in_progress" },
      ]),
    });
    const newState = updateSelfDrivingProgress(state, task, NOW);
    expect(newState.sameStepCount).toBe(1);
    expect(newState.lastStepId).toBe("s2");
    expect(newState.escalated).toBe(false);
  });

  it("tracks zero-progress runs", () => {
    const state = makeSelfDrivingState({ lastDoneCount: 2, zeroProgressCount: 1, lastContinuationTs: NOW - 10_000 });
    const task = makeTask({
      steps: makeSteps([
        { id: "s1", status: "done" },
        { id: "s2", status: "done" },
        { id: "s3", status: "pending" },
      ]),
    });
    const newState = updateSelfDrivingProgress(state, task, NOW);
    expect(newState.zeroProgressCount).toBe(2);
  });

  it("resets zero-progress on progress", () => {
    const state = makeSelfDrivingState({ lastDoneCount: 1, zeroProgressCount: 3 });
    const task = makeTask({
      steps: makeSteps([
        { id: "s1", status: "done" },
        { id: "s2", status: "done" },
        { id: "s3", status: "pending" },
      ]),
    });
    const newState = updateSelfDrivingProgress(state, task, NOW);
    expect(newState.zeroProgressCount).toBe(0);
    expect(newState.lastDoneCount).toBe(2);
  });

  it("resets on cooldown expiry", () => {
    const state = makeSelfDrivingState({
      consecutiveCount: 10,
      sameStepCount: 5,
      zeroProgressCount: 3,
      escalated: true,
      lastContinuationTs: NOW - 120_000, // 2 min ago (> 1 min cooldown)
    });
    const task = makeTask({ steps: makeSteps([{ id: "s1", status: "pending" }]) });
    const newState = updateSelfDrivingProgress(state, task, NOW, 60_000);
    expect(newState.consecutiveCount).toBe(1); // reset to 0, then +1
    expect(newState.sameStepCount).toBe(1);
    expect(newState.zeroProgressCount).toBe(1);
    expect(newState.escalated).toBe(false);
  });
});
