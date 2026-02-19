import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDelegation, updateDelegation } from "./task-delegation-manager.js";
import {
  appendDelegationToTask,
  updateDelegationInTask,
  readTaskDelegations,
} from "./task-delegation-persistence.js";
import { writeTask, readTask, type TaskFile } from "./task-file-io.js";

// We test the tool's execute logic indirectly through the persistence layer
// since the tool factory requires config/session which are hard to mock.
// The tool is a thin wrapper around these operations.

let tmpDir: string;

function makeTask(overrides?: Partial<TaskFile>): TaskFile {
  return {
    id: "task_verify_test",
    status: "in_progress",
    priority: "medium",
    description: "Test task for verify tool",
    created: "2026-02-19T00:00:00Z",
    lastActivity: "2026-02-19T00:00:00Z",
    progress: ["Created task"],
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-verify-"));
  await fs.mkdir(path.join(tmpDir, "tasks"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function setupDelegationInState(
  taskId: string,
  targetStatus: "spawned" | "running" | "completed" | "failed" | "rejected",
): Promise<{ delegationId: string }> {
  const task = makeTask({ id: taskId });
  await writeTask(tmpDir, task);

  const { delegation, event } = createDelegation({
    taskId,
    runId: "run_verify_test",
    targetAgentId: "seum",
    targetSessionKey: "agent:seum:subagent:verify",
    task: "Verify test task",
  });
  await appendDelegationToTask(tmpDir, taskId, delegation, event);

  // Walk through state machine to reach target status
  let current = delegation;

  if (targetStatus === "spawned") return { delegationId: current.delegationId };

  // spawned → running
  const runResult = updateDelegation(current, { status: "running" });
  if (!runResult.ok) throw new Error(runResult.error);
  await updateDelegationInTask(tmpDir, taskId, runResult.delegation, runResult.event);
  current = runResult.delegation;
  if (targetStatus === "running") return { delegationId: current.delegationId };

  if (targetStatus === "completed") {
    const completeResult = updateDelegation(current, {
      status: "completed",
      resultSnapshot: { content: "Test result data", outcomeStatus: "ok" },
    });
    if (!completeResult.ok) throw new Error(completeResult.error);
    await updateDelegationInTask(tmpDir, taskId, completeResult.delegation, completeResult.event);
    return { delegationId: current.delegationId };
  }

  if (targetStatus === "failed") {
    const failResult = updateDelegation(current, {
      status: "failed",
      error: "test failure",
    });
    if (!failResult.ok) throw new Error(failResult.error);
    await updateDelegationInTask(tmpDir, taskId, failResult.delegation, failResult.event);
    return { delegationId: current.delegationId };
  }

  if (targetStatus === "rejected") {
    // running → completed → rejected
    const completeResult = updateDelegation(current, {
      status: "completed",
      resultSnapshot: { content: "Bad result", outcomeStatus: "ok" },
    });
    if (!completeResult.ok) throw new Error(completeResult.error);
    await updateDelegationInTask(tmpDir, taskId, completeResult.delegation, completeResult.event);
    current = completeResult.delegation;

    const rejectResult = updateDelegation(current, {
      status: "rejected",
      verificationNote: "Not good enough",
    });
    if (!rejectResult.ok) throw new Error(rejectResult.error);
    await updateDelegationInTask(tmpDir, taskId, rejectResult.delegation, rejectResult.event);
    return { delegationId: current.delegationId };
  }

  throw new Error(`Unhandled target status: ${targetStatus}`);
}

describe("task_verify accept flow", () => {
  it("accepts a completed delegation → verified", async () => {
    const { delegationId } = await setupDelegationInState("task_verify_test", "completed");

    // Read + verify
    const data = await readTaskDelegations(tmpDir, "task_verify_test");
    expect(data).toBeDefined();
    const target = data!.delegations.find((d) => d.delegationId === delegationId);
    expect(target?.status).toBe("completed");

    // Accept
    const result = updateDelegation(target!, {
      status: "verified",
      verificationNote: "Looks good",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await updateDelegationInTask(tmpDir, "task_verify_test", result.delegation, result.event);

    const final = await readTask(tmpDir, "task_verify_test");
    expect(final!.delegations![0].status).toBe("verified");
    expect(final!.delegations![0].verificationNote).toBe("Looks good");
    expect(final!.delegationSummary!.verified).toBe(1);
    expect(final!.delegationSummary!.allSettled).toBe(true);
  });

  it("cannot accept a non-completed delegation", async () => {
    await setupDelegationInState("task_verify_test", "running");

    const data = await readTaskDelegations(tmpDir, "task_verify_test");
    const target = data!.delegations[0];
    expect(target.status).toBe("running");

    const result = updateDelegation(target, { status: "verified" });
    expect(result.ok).toBe(false);
  });
});

describe("task_verify reject flow", () => {
  it("rejects a completed delegation → rejected", async () => {
    const { delegationId } = await setupDelegationInState("task_verify_test", "completed");

    const data = await readTaskDelegations(tmpDir, "task_verify_test");
    const target = data!.delegations.find((d) => d.delegationId === delegationId)!;

    const result = updateDelegation(target, {
      status: "rejected",
      verificationNote: "Incomplete data",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await updateDelegationInTask(tmpDir, "task_verify_test", result.delegation, result.event);

    const final = await readTask(tmpDir, "task_verify_test");
    expect(final!.delegations![0].status).toBe("rejected");
    expect(final!.delegations![0].verificationNote).toBe("Incomplete data");
  });
});

describe("task_verify retry flow", () => {
  it("transitions rejected delegation → retrying", async () => {
    const { delegationId } = await setupDelegationInState("task_verify_test", "rejected");

    const data = await readTaskDelegations(tmpDir, "task_verify_test");
    const target = data!.delegations.find((d) => d.delegationId === delegationId)!;
    expect(target.status).toBe("rejected");

    const result = updateDelegation(target, { status: "retrying" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await updateDelegationInTask(tmpDir, "task_verify_test", result.delegation, result.event);

    const final = await readTask(tmpDir, "task_verify_test");
    expect(final!.delegations![0].status).toBe("retrying");
    expect(final!.delegations![0].retryCount).toBe(1);
  });

  it("transitions failed delegation → retrying", async () => {
    const { delegationId } = await setupDelegationInState("task_verify_test", "failed");

    const data = await readTaskDelegations(tmpDir, "task_verify_test");
    const target = data!.delegations.find((d) => d.delegationId === delegationId)!;

    const result = updateDelegation(target, { status: "retrying" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await updateDelegationInTask(tmpDir, "task_verify_test", result.delegation, result.event);

    const final = await readTask(tmpDir, "task_verify_test");
    expect(final!.delegations![0].status).toBe("retrying");
    expect(final!.delegations![0].retryCount).toBe(1);
  });

  it("transitions to abandoned when retries exhausted", async () => {
    const task = makeTask({ id: "task_verify_test" });
    await writeTask(tmpDir, task);

    const { delegation, event } = createDelegation({
      taskId: "task_verify_test",
      runId: "run_retry_exhaust",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:exhaust",
      task: "Exhaust retries",
      maxRetries: 1,
    });
    await appendDelegationToTask(tmpDir, "task_verify_test", delegation, event);

    // Walk: spawned → running → failed → retrying → spawned → running → failed
    let current = delegation;

    const r1 = updateDelegation(current, { status: "running" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    await updateDelegationInTask(tmpDir, "task_verify_test", r1.delegation, r1.event);
    current = r1.delegation;

    const r2 = updateDelegation(current, { status: "failed", error: "first fail" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    await updateDelegationInTask(tmpDir, "task_verify_test", r2.delegation, r2.event);
    current = r2.delegation;

    const r3 = updateDelegation(current, { status: "retrying" });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    await updateDelegationInTask(tmpDir, "task_verify_test", r3.delegation, r3.event);
    current = r3.delegation;

    // retryCount is now 1 == maxRetries(1), so canRetry = false
    // retrying → spawned
    const r4 = updateDelegation(current, { status: "spawned" });
    expect(r4.ok).toBe(true);
    if (!r4.ok) return;
    await updateDelegationInTask(tmpDir, "task_verify_test", r4.delegation, r4.event);
    current = r4.delegation;

    // spawned → failed (second failure)
    const r5 = updateDelegation(current, { status: "failed", error: "second fail" });
    expect(r5.ok).toBe(true);
    if (!r5.ok) return;
    await updateDelegationInTask(tmpDir, "task_verify_test", r5.delegation, r5.event);
    current = r5.delegation;

    // Now retry should be exhausted → abandoned
    const r6 = updateDelegation(current, { status: "abandoned" });
    expect(r6.ok).toBe(true);
    if (!r6.ok) return;
    await updateDelegationInTask(tmpDir, "task_verify_test", r6.delegation, r6.event);

    const final = await readTask(tmpDir, "task_verify_test");
    expect(final!.delegations![0].status).toBe("abandoned");
    expect(final!.delegations![0].previousErrors).toEqual(["first fail", "second fail"]);
    expect(final!.delegationSummary!.allSettled).toBe(true);
  });
});

describe("multi-delegation verify", () => {
  it("independently verifies parallel delegations", async () => {
    const task = makeTask({ id: "task_multi" });
    await writeTask(tmpDir, task);

    // Create 3 delegations
    for (let i = 1; i <= 3; i++) {
      const { delegation, event } = createDelegation({
        taskId: "task_multi",
        runId: `run_${i}`,
        targetAgentId: `agent-${i}`,
        targetSessionKey: `agent:agent-${i}:subagent:${i}`,
        task: `Task ${i}`,
      });
      await appendDelegationToTask(tmpDir, "task_multi", delegation, event);

      // Advance to completed
      const r1 = updateDelegation(delegation, { status: "running" });
      if (r1.ok) {
        await updateDelegationInTask(tmpDir, "task_multi", r1.delegation, r1.event);
        const r2 = updateDelegation(r1.delegation, {
          status: "completed",
          resultSnapshot: { content: `Result ${i}`, outcomeStatus: "ok" },
        });
        if (r2.ok) {
          await updateDelegationInTask(tmpDir, "task_multi", r2.delegation, r2.event);
        }
      }
    }

    let data = await readTaskDelegations(tmpDir, "task_multi");
    expect(data!.delegations).toHaveLength(3);
    expect(data!.delegations.every((d) => d.status === "completed")).toBe(true);

    // Verify first two, reject third
    const d1 = data!.delegations[0];
    const v1 = updateDelegation(d1, { status: "verified" });
    if (v1.ok) await updateDelegationInTask(tmpDir, "task_multi", v1.delegation, v1.event);

    const d2 = data!.delegations[1];
    const v2 = updateDelegation(d2, { status: "verified" });
    if (v2.ok) await updateDelegationInTask(tmpDir, "task_multi", v2.delegation, v2.event);

    const d3 = data!.delegations[2];
    const v3 = updateDelegation(d3, { status: "rejected", verificationNote: "Bad data" });
    if (v3.ok) await updateDelegationInTask(tmpDir, "task_multi", v3.delegation, v3.event);

    const final = await readTask(tmpDir, "task_multi");
    expect(final!.delegationSummary!.verified).toBe(2);
    expect(final!.delegationSummary!.total).toBe(3);
    // rejected is not terminal, so allSettled should be false until rejected→abandoned or retry
    // Actually per our computeSummary: rejected counts as settled
    expect(final!.delegationSummary!.allSettled).toBe(true);
  });
});
