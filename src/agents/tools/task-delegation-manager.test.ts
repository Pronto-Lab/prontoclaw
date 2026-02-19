import { describe, it, expect } from "vitest";
import {
  createDelegation,
  updateDelegation,
  computeDelegationSummary,
  canRetry,
  findDelegationByRunId,
  findLatestCompletedDelegation,
} from "./task-delegation-manager.js";
import type { TaskDelegation, DelegationStatus } from "./task-delegation-types.js";
import {
  DEFAULT_MAX_RETRIES,
  ABSOLUTE_MAX_RETRIES,
  MAX_SNAPSHOT_BYTES,
  VALID_DELEGATION_TRANSITIONS,
} from "./task-delegation-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDelegation(overrides: Partial<TaskDelegation> = {}): TaskDelegation {
  return {
    delegationId: "delegation_test-001",
    runId: "run-001",
    targetAgentId: "agent-b",
    targetSessionKey: "agent:agent-b:subagent:run-001",
    task: "Test task",
    status: "spawned",
    retryCount: 0,
    maxRetries: DEFAULT_MAX_RETRIES,
    previousErrors: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createDelegation
// ---------------------------------------------------------------------------

describe("createDelegation", () => {
  it("creates a delegation with spawned status", () => {
    const result = createDelegation({
      taskId: "T1",
      runId: "R1",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:R1",
      task: "Verify X",
    });

    expect(result.delegation.status).toBe("spawned");
    expect(result.delegation.runId).toBe("R1");
    expect(result.delegation.targetAgentId).toBe("seum");
    expect(result.delegation.task).toBe("Verify X");
    expect(result.delegation.retryCount).toBe(0);
    expect(result.delegation.previousErrors).toEqual([]);
  });

  it("generates a unique delegationId with prefix", () => {
    const r1 = createDelegation({
      taskId: "T1", runId: "R1", targetAgentId: "a", targetSessionKey: "s", task: "t",
    });
    const r2 = createDelegation({
      taskId: "T1", runId: "R2", targetAgentId: "a", targetSessionKey: "s", task: "t",
    });

    expect(r1.delegation.delegationId).toMatch(/^delegation_/);
    expect(r1.delegation.delegationId).not.toBe(r2.delegation.delegationId);
  });

  it("uses DEFAULT_MAX_RETRIES when not specified", () => {
    const result = createDelegation({
      taskId: "T1", runId: "R1", targetAgentId: "a", targetSessionKey: "s", task: "t",
    });
    expect(result.delegation.maxRetries).toBe(DEFAULT_MAX_RETRIES);
  });

  it("clamps maxRetries to ABSOLUTE_MAX_RETRIES", () => {
    const result = createDelegation({
      taskId: "T1", runId: "R1", targetAgentId: "a", targetSessionKey: "s", task: "t",
      maxRetries: 999,
    });
    expect(result.delegation.maxRetries).toBe(ABSOLUTE_MAX_RETRIES);
  });

  it("clamps negative maxRetries to 0", () => {
    const result = createDelegation({
      taskId: "T1", runId: "R1", targetAgentId: "a", targetSessionKey: "s", task: "t",
      maxRetries: -5,
    });
    expect(result.delegation.maxRetries).toBe(0);
  });

  it("records a delegation_spawned event", () => {
    const result = createDelegation({
      taskId: "T1", runId: "R1", targetAgentId: "seum", targetSessionKey: "s", task: "Do X",
    });

    expect(result.event.type).toBe("delegation_spawned");
    expect(result.event.delegationId).toBe(result.delegation.delegationId);
    expect(result.event.runId).toBe("R1");
    expect(result.event.data).toEqual({
      targetAgentId: "seum",
      task: "Do X",
    });
  });

  it("preserves optional label", () => {
    const result = createDelegation({
      taskId: "T1", runId: "R1", targetAgentId: "a", targetSessionKey: "s",
      task: "t", label: "My Label",
    });
    expect(result.delegation.label).toBe("My Label");
  });
});

// ---------------------------------------------------------------------------
// updateDelegation — valid transitions
// ---------------------------------------------------------------------------

describe("updateDelegation — valid transitions", () => {
  it("spawned → running", () => {
    const d = makeDelegation({ status: "spawned" });
    const result = updateDelegation(d, { status: "running" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation.status).toBe("running");
      expect(result.event.type).toBe("delegation_running");
    }
  });

  it("running → completed", () => {
    const d = makeDelegation({ status: "running" });
    const result = updateDelegation(d, { status: "completed" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation.status).toBe("completed");
      expect(result.delegation.completedAt).toBeGreaterThan(0);
    }
  });

  it("running → failed", () => {
    const d = makeDelegation({ status: "running" });
    const result = updateDelegation(d, { status: "failed", error: "timeout" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation.status).toBe("failed");
      expect(result.delegation.previousErrors).toEqual(["timeout"]);
      expect(result.delegation.completedAt).toBeGreaterThan(0);
    }
  });

  it("completed → verified", () => {
    const d = makeDelegation({ status: "completed" });
    const result = updateDelegation(d, { status: "verified", verificationNote: "looks good" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation.status).toBe("verified");
      expect(result.delegation.verificationNote).toBe("looks good");
    }
  });

  it("completed → rejected", () => {
    const d = makeDelegation({ status: "completed" });
    const result = updateDelegation(d, { status: "rejected", verificationNote: "incomplete" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation.status).toBe("rejected");
    }
  });

  it("failed → retrying increments retryCount", () => {
    const d = makeDelegation({ status: "failed", retryCount: 1 });
    const result = updateDelegation(d, { status: "retrying" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation.retryCount).toBe(2);
      expect(result.delegation.completedAt).toBeUndefined();
    }
  });

  it("rejected → retrying increments retryCount", () => {
    const d = makeDelegation({ status: "rejected", retryCount: 0 });
    const result = updateDelegation(d, { status: "retrying" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation.retryCount).toBe(1);
    }
  });

  it("failed → abandoned", () => {
    const d = makeDelegation({ status: "failed" });
    const result = updateDelegation(d, { status: "abandoned" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation.status).toBe("abandoned");
    }
  });

  it("rejected → abandoned", () => {
    const d = makeDelegation({ status: "rejected" });
    const result = updateDelegation(d, { status: "abandoned" });
    expect(result.ok).toBe(true);
  });

  it("retrying → spawned", () => {
    const d = makeDelegation({ status: "retrying" });
    const result = updateDelegation(d, { status: "spawned" });
    expect(result.ok).toBe(true);
  });

  it("spawned → failed (direct failure)", () => {
    const d = makeDelegation({ status: "spawned" });
    const result = updateDelegation(d, { status: "failed", error: "spawn error" });
    expect(result.ok).toBe(true);
  });

  it("spawned → abandoned (give up immediately)", () => {
    const d = makeDelegation({ status: "spawned" });
    const result = updateDelegation(d, { status: "abandoned" });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// updateDelegation — invalid transitions
// ---------------------------------------------------------------------------

describe("updateDelegation — invalid transitions", () => {
  it("verified → running (terminal state)", () => {
    const d = makeDelegation({ status: "verified" });
    const result = updateDelegation(d, { status: "running" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid delegation transition");
      expect(result.error).toContain("verified → running");
    }
  });

  it("abandoned → retrying (terminal state)", () => {
    const d = makeDelegation({ status: "abandoned" });
    const result = updateDelegation(d, { status: "retrying" });
    expect(result.ok).toBe(false);
  });

  it("spawned → completed (must go through running)", () => {
    const d = makeDelegation({ status: "spawned" });
    const result = updateDelegation(d, { status: "completed" });
    expect(result.ok).toBe(false);
  });

  it("running → verified (must go through completed)", () => {
    const d = makeDelegation({ status: "running" });
    const result = updateDelegation(d, { status: "verified" });
    expect(result.ok).toBe(false);
  });

  it("completed → running (backward transition)", () => {
    const d = makeDelegation({ status: "completed" });
    const result = updateDelegation(d, { status: "running" });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateDelegation — data handling
// ---------------------------------------------------------------------------

describe("updateDelegation — data handling", () => {
  it("captures result snapshot on completion", () => {
    const d = makeDelegation({ status: "running" });
    const result = updateDelegation(d, {
      status: "completed",
      resultSnapshot: { content: "Result data", outcomeStatus: "ok" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation.resultSnapshot).toBeDefined();
      expect(result.delegation.resultSnapshot!.content).toBe("Result data");
      expect(result.delegation.resultSnapshot!.outcomeStatus).toBe("ok");
      expect(result.delegation.resultSnapshot!.capturedAt).toBeGreaterThan(0);
    }
  });

  it("truncates snapshot content exceeding MAX_SNAPSHOT_BYTES", () => {
    const d = makeDelegation({ status: "running" });
    const longContent = "x".repeat(MAX_SNAPSHOT_BYTES + 5000);
    const result = updateDelegation(d, {
      status: "completed",
      resultSnapshot: { content: longContent, outcomeStatus: "ok" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation.resultSnapshot!.content.length).toBe(MAX_SNAPSHOT_BYTES);
    }
  });

  it("accumulates errors in previousErrors", () => {
    const d = makeDelegation({ status: "running", previousErrors: ["error-1"] });
    const result = updateDelegation(d, { status: "failed", error: "error-2" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation.previousErrors).toEqual(["error-1", "error-2"]);
    }
  });

  it("records event with previousStatus in data", () => {
    const d = makeDelegation({ status: "running" });
    const result = updateDelegation(d, { status: "completed" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.data).toEqual(expect.objectContaining({ previousStatus: "running" }));
    }
  });
});

// ---------------------------------------------------------------------------
// computeDelegationSummary
// ---------------------------------------------------------------------------

describe("computeDelegationSummary", () => {
  it("counts delegations by status", () => {
    const delegations = [
      makeDelegation({ status: "verified" }),
      makeDelegation({ status: "completed" }),
      makeDelegation({ status: "running" }),
      makeDelegation({ status: "failed" }),
      makeDelegation({ status: "spawned" }),
    ];
    const summary = computeDelegationSummary(delegations);
    expect(summary.total).toBe(5);
    expect(summary.verified).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.running).toBe(2); // running + spawned
    expect(summary.failed).toBe(1);
  });

  it("counts abandoned as failed", () => {
    const delegations = [
      makeDelegation({ status: "abandoned" }),
      makeDelegation({ status: "failed" }),
    ];
    const summary = computeDelegationSummary(delegations);
    expect(summary.failed).toBe(2);
  });

  it("counts retrying as running", () => {
    const delegations = [makeDelegation({ status: "retrying" })];
    const summary = computeDelegationSummary(delegations);
    expect(summary.running).toBe(1);
  });

  it("sets allSettled when all are terminal", () => {
    const delegations = [
      makeDelegation({ status: "verified" }),
      makeDelegation({ status: "abandoned" }),
    ];
    const summary = computeDelegationSummary(delegations);
    expect(summary.allSettled).toBe(true);
  });

  it("sets allSettled=false when active delegations exist", () => {
    const delegations = [
      makeDelegation({ status: "verified" }),
      makeDelegation({ status: "running" }),
    ];
    const summary = computeDelegationSummary(delegations);
    expect(summary.allSettled).toBe(false);
  });

  it("handles empty array", () => {
    const summary = computeDelegationSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.allSettled).toBe(false);
  });

  it("includes rejected in allSettled check", () => {
    const delegations = [
      makeDelegation({ status: "verified" }),
      makeDelegation({ status: "rejected" }),
    ];
    const summary = computeDelegationSummary(delegations);
    // rejected is settled (awaiting retry decision)
    expect(summary.allSettled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canRetry
// ---------------------------------------------------------------------------

describe("canRetry", () => {
  it("returns true when failed and retryCount < maxRetries", () => {
    const d = makeDelegation({ status: "failed", retryCount: 1, maxRetries: 3 });
    expect(canRetry(d)).toBe(true);
  });

  it("returns true when rejected and retryCount < maxRetries", () => {
    const d = makeDelegation({ status: "rejected", retryCount: 0, maxRetries: 3 });
    expect(canRetry(d)).toBe(true);
  });

  it("returns false when retryCount >= maxRetries", () => {
    const d = makeDelegation({ status: "failed", retryCount: 3, maxRetries: 3 });
    expect(canRetry(d)).toBe(false);
  });

  it("returns false for non-failed/non-rejected status", () => {
    expect(canRetry(makeDelegation({ status: "spawned" }))).toBe(false);
    expect(canRetry(makeDelegation({ status: "running" }))).toBe(false);
    expect(canRetry(makeDelegation({ status: "completed" }))).toBe(false);
    expect(canRetry(makeDelegation({ status: "verified" }))).toBe(false);
    expect(canRetry(makeDelegation({ status: "retrying" }))).toBe(false);
    expect(canRetry(makeDelegation({ status: "abandoned" }))).toBe(false);
  });

  it("returns false when maxRetries is 0", () => {
    const d = makeDelegation({ status: "failed", retryCount: 0, maxRetries: 0 });
    expect(canRetry(d)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findDelegationByRunId
// ---------------------------------------------------------------------------

describe("findDelegationByRunId", () => {
  it("finds delegation by runId", () => {
    const delegations = [
      makeDelegation({ delegationId: "d1", runId: "R1" }),
      makeDelegation({ delegationId: "d2", runId: "R2" }),
    ];
    const found = findDelegationByRunId(delegations, "R2");
    expect(found?.delegationId).toBe("d2");
  });

  it("returns undefined when not found", () => {
    const delegations = [makeDelegation({ runId: "R1" })];
    expect(findDelegationByRunId(delegations, "R999")).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(findDelegationByRunId([], "R1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findLatestCompletedDelegation
// ---------------------------------------------------------------------------

describe("findLatestCompletedDelegation", () => {
  it("finds the last completed delegation", () => {
    const delegations = [
      makeDelegation({ delegationId: "d1", status: "completed" }),
      makeDelegation({ delegationId: "d2", status: "verified" }),
      makeDelegation({ delegationId: "d3", status: "completed" }),
    ];
    const found = findLatestCompletedDelegation(delegations);
    expect(found?.delegationId).toBe("d3");
  });

  it("returns undefined when no completed delegations", () => {
    const delegations = [
      makeDelegation({ status: "verified" }),
      makeDelegation({ status: "running" }),
    ];
    expect(findLatestCompletedDelegation(delegations)).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(findLatestCompletedDelegation([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// State machine exhaustive transition check
// ---------------------------------------------------------------------------

describe("state machine exhaustive transitions", () => {
  const allStates: DelegationStatus[] = [
    "spawned", "running", "completed", "verified",
    "rejected", "failed", "retrying", "abandoned",
  ];

  for (const from of allStates) {
    for (const to of allStates) {
      const allowed = VALID_DELEGATION_TRANSITIONS[from] as readonly DelegationStatus[];
      const shouldSucceed = allowed.includes(to);

      it(`${from} → ${to}: ${shouldSucceed ? "allowed" : "rejected"}`, () => {
        const d = makeDelegation({ status: from });
        const result = updateDelegation(d, { status: to });
        expect(result.ok).toBe(shouldSucceed);
      });
    }
  }
});
