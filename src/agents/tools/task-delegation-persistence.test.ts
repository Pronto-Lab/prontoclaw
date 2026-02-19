import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  appendDelegationToTask,
  updateDelegationInTask,
  readDelegationByRunId,
  readTaskDelegations,
} from "./task-delegation-persistence.js";
import { createDelegation, updateDelegation, computeDelegationSummary } from "./task-delegation-manager.js";
import type { TaskDelegation, DelegationEvent } from "./task-delegation-types.js";
import {
  formatTaskFileMd,
  parseTaskFileMd,
  writeTask,
  readTask,
  type TaskFile,
} from "./task-file-io.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTask(overrides?: Partial<TaskFile>): TaskFile {
  return {
    id: "task_test123",
    status: "in_progress",
    priority: "medium",
    description: "Test task for delegation persistence",
    created: "2026-02-19T00:00:00Z",
    lastActivity: "2026-02-19T00:00:00Z",
    progress: ["Created task"],
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-deleg-persist-"));
  // Create tasks dir
  await fs.mkdir(path.join(tmpDir, "tasks"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TaskFile serialization round-trip with delegations
// ---------------------------------------------------------------------------

describe("TaskFile delegation serialization", () => {
  it("round-trips delegations through formatTaskFileMd/parseTaskFileMd", () => {
    const delegation: TaskDelegation = {
      delegationId: "delegation_abc123",
      runId: "run_xyz",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:xyz",
      task: "Collect data",
      label: "Data Collection",
      status: "completed",
      retryCount: 0,
      maxRetries: 3,
      previousErrors: [],
      resultSnapshot: {
        content: "Found 42 items",
        outcomeStatus: "ok",
        capturedAt: 1708300000000,
      },
      createdAt: 1708300000000,
      updatedAt: 1708300000000,
      completedAt: 1708300000000,
    };

    const event: DelegationEvent = {
      type: "delegation_spawned",
      delegationId: "delegation_abc123",
      runId: "run_xyz",
      timestamp: 1708300000000,
      data: { targetAgentId: "seum", task: "Collect data" },
    };

    const task = makeTask({
      delegations: [delegation],
      delegationEvents: [event],
      delegationSummary: computeDelegationSummary([delegation]),
    });

    const md = formatTaskFileMd(task);
    expect(md).toContain("## Delegations");
    expect(md).toContain("delegation_abc123");

    const parsed = parseTaskFileMd(md, "task_test123.md");
    expect(parsed).not.toBeNull();
    expect(parsed!.delegations).toHaveLength(1);
    expect(parsed!.delegations![0].delegationId).toBe("delegation_abc123");
    expect(parsed!.delegations![0].status).toBe("completed");
    expect(parsed!.delegations![0].resultSnapshot?.content).toBe("Found 42 items");
    expect(parsed!.delegationEvents).toHaveLength(1);
    expect(parsed!.delegationEvents![0].type).toBe("delegation_spawned");
    expect(parsed!.delegationSummary).toBeDefined();
    expect(parsed!.delegationSummary!.total).toBe(1);
    expect(parsed!.delegationSummary!.completed).toBe(1);
  });

  it("round-trips task without delegations (backward compat)", () => {
    const task = makeTask();
    const md = formatTaskFileMd(task);
    expect(md).not.toContain("## Delegations");

    const parsed = parseTaskFileMd(md, "task_test123.md");
    expect(parsed).not.toBeNull();
    expect(parsed!.delegations).toBeUndefined();
    expect(parsed!.delegationEvents).toBeUndefined();
    expect(parsed!.delegationSummary).toBeUndefined();
  });

  it("round-trips multiple delegations", () => {
    const d1: TaskDelegation = {
      delegationId: "delegation_001",
      runId: "run_001",
      targetAgentId: "agent-a",
      targetSessionKey: "agent:agent-a:subagent:001",
      task: "Task A",
      status: "verified",
      retryCount: 0,
      maxRetries: 3,
      previousErrors: [],
      createdAt: 1708300000000,
      updatedAt: 1708300000000,
    };

    const d2: TaskDelegation = {
      delegationId: "delegation_002",
      runId: "run_002",
      targetAgentId: "agent-b",
      targetSessionKey: "agent:agent-b:subagent:002",
      task: "Task B",
      status: "failed",
      retryCount: 1,
      maxRetries: 3,
      previousErrors: ["timeout error"],
      createdAt: 1708300000000,
      updatedAt: 1708300000000,
    };

    const task = makeTask({
      delegations: [d1, d2],
      delegationEvents: [],
      delegationSummary: computeDelegationSummary([d1, d2]),
    });

    const md = formatTaskFileMd(task);
    const parsed = parseTaskFileMd(md, "task_test123.md");
    expect(parsed!.delegations).toHaveLength(2);
    expect(parsed!.delegations![0].delegationId).toBe("delegation_001");
    expect(parsed!.delegations![1].delegationId).toBe("delegation_002");
    expect(parsed!.delegationSummary!.total).toBe(2);
    expect(parsed!.delegationSummary!.verified).toBe(1);
    expect(parsed!.delegationSummary!.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence helpers (file-based)
// ---------------------------------------------------------------------------

describe("appendDelegationToTask", () => {
  it("appends delegation to existing task", async () => {
    const task = makeTask();
    await writeTask(tmpDir, task);

    const { delegation, event } = createDelegation({
      taskId: task.id,
      runId: "run_001",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:001",
      task: "Investigate X",
    });

    const ok = await appendDelegationToTask(tmpDir, task.id, delegation, event);
    expect(ok).toBe(true);

    const updated = await readTask(tmpDir, task.id);
    expect(updated).not.toBeNull();
    expect(updated!.delegations).toHaveLength(1);
    expect(updated!.delegations![0].delegationId).toBe(delegation.delegationId);
    expect(updated!.delegations![0].status).toBe("spawned");
    expect(updated!.delegationEvents).toHaveLength(1);
    expect(updated!.delegationEvents![0].type).toBe("delegation_spawned");
    expect(updated!.delegationSummary).toBeDefined();
    expect(updated!.delegationSummary!.total).toBe(1);
    expect(updated!.delegationSummary!.running).toBe(1);
  });

  it("appends multiple delegations", async () => {
    const task = makeTask();
    await writeTask(tmpDir, task);

    const { delegation: d1, event: e1 } = createDelegation({
      taskId: task.id,
      runId: "run_001",
      targetAgentId: "agent-a",
      targetSessionKey: "agent:agent-a:subagent:001",
      task: "Task A",
    });
    await appendDelegationToTask(tmpDir, task.id, d1, e1);

    const { delegation: d2, event: e2 } = createDelegation({
      taskId: task.id,
      runId: "run_002",
      targetAgentId: "agent-b",
      targetSessionKey: "agent:agent-b:subagent:002",
      task: "Task B",
    });
    await appendDelegationToTask(tmpDir, task.id, d2, e2);

    const updated = await readTask(tmpDir, task.id);
    expect(updated!.delegations).toHaveLength(2);
    expect(updated!.delegationEvents).toHaveLength(2);
    expect(updated!.delegationSummary!.total).toBe(2);
    expect(updated!.delegationSummary!.running).toBe(2);
  });

  it("returns false for non-existent task", async () => {
    const { delegation, event } = createDelegation({
      taskId: "task_nonexistent",
      runId: "run_001",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:001",
      task: "Test",
    });

    const ok = await appendDelegationToTask(tmpDir, "task_nonexistent", delegation, event);
    expect(ok).toBe(false);
  });
});

describe("updateDelegationInTask", () => {
  it("updates delegation status in task file", async () => {
    const task = makeTask();
    await writeTask(tmpDir, task);

    // Append initial delegation
    const { delegation, event: createEvent } = createDelegation({
      taskId: task.id,
      runId: "run_001",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:001",
      task: "Investigate X",
    });
    await appendDelegationToTask(tmpDir, task.id, delegation, createEvent);

    // Update to running
    const result = updateDelegation(delegation, { status: "running" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ok = await updateDelegationInTask(
      tmpDir,
      task.id,
      result.delegation,
      result.event,
    );
    expect(ok).toBe(true);

    const updated = await readTask(tmpDir, task.id);
    expect(updated!.delegations![0].status).toBe("running");
    expect(updated!.delegationEvents).toHaveLength(2);
    expect(updated!.delegationSummary!.running).toBe(1);
  });

  it("updates delegation with result snapshot", async () => {
    // Set up: spawned → running → completed
    const task = makeTask();
    await writeTask(tmpDir, task);

    const { delegation, event: createEvent } = createDelegation({
      taskId: task.id,
      runId: "run_001",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:001",
      task: "Collect data",
    });
    await appendDelegationToTask(tmpDir, task.id, delegation, createEvent);

    // spawned → running
    const runResult = updateDelegation(delegation, { status: "running" });
    expect(runResult.ok).toBe(true);
    if (!runResult.ok) return;
    await updateDelegationInTask(tmpDir, task.id, runResult.delegation, runResult.event);

    // running → completed with snapshot
    const completeResult = updateDelegation(runResult.delegation, {
      status: "completed",
      resultSnapshot: { content: "Found 42 items", outcomeStatus: "ok" },
    });
    expect(completeResult.ok).toBe(true);
    if (!completeResult.ok) return;
    await updateDelegationInTask(tmpDir, task.id, completeResult.delegation, completeResult.event);

    const updated = await readTask(tmpDir, task.id);
    expect(updated!.delegations![0].status).toBe("completed");
    expect(updated!.delegations![0].resultSnapshot?.content).toBe("Found 42 items");
    expect(updated!.delegationEvents).toHaveLength(3);
    expect(updated!.delegationSummary!.completed).toBe(1);
  });

  it("returns false for non-existent delegation", async () => {
    const task = makeTask();
    await writeTask(tmpDir, task);

    const fakeDelegation: TaskDelegation = {
      delegationId: "delegation_fake",
      runId: "run_fake",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:fake",
      task: "Fake",
      status: "running",
      retryCount: 0,
      maxRetries: 3,
      previousErrors: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const fakeEvent: DelegationEvent = {
      type: "delegation_running",
      delegationId: "delegation_fake",
      runId: "run_fake",
      timestamp: Date.now(),
    };

    const ok = await updateDelegationInTask(tmpDir, task.id, fakeDelegation, fakeEvent);
    expect(ok).toBe(false);
  });

  it("returns false for non-existent task", async () => {
    const fakeDelegation: TaskDelegation = {
      delegationId: "delegation_fake",
      runId: "run_fake",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:fake",
      task: "Fake",
      status: "running",
      retryCount: 0,
      maxRetries: 3,
      previousErrors: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const fakeEvent: DelegationEvent = {
      type: "delegation_running",
      delegationId: "delegation_fake",
      runId: "run_fake",
      timestamp: Date.now(),
    };

    const ok = await updateDelegationInTask(tmpDir, "task_nonexistent", fakeDelegation, fakeEvent);
    expect(ok).toBe(false);
  });
});

describe("readDelegationByRunId", () => {
  it("finds delegation by runId", async () => {
    const task = makeTask();
    await writeTask(tmpDir, task);

    const { delegation, event } = createDelegation({
      taskId: task.id,
      runId: "run_target",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:target",
      task: "Target task",
    });
    await appendDelegationToTask(tmpDir, task.id, delegation, event);

    const found = await readDelegationByRunId(tmpDir, task.id, "run_target");
    expect(found).toBeDefined();
    expect(found!.runId).toBe("run_target");
    expect(found!.delegationId).toBe(delegation.delegationId);
  });

  it("returns undefined for unknown runId", async () => {
    const task = makeTask();
    await writeTask(tmpDir, task);

    const found = await readDelegationByRunId(tmpDir, task.id, "run_unknown");
    expect(found).toBeUndefined();
  });

  it("returns undefined for non-existent task", async () => {
    const found = await readDelegationByRunId(tmpDir, "task_nonexistent", "run_001");
    expect(found).toBeUndefined();
  });
});

describe("readTaskDelegations", () => {
  it("returns task and delegations", async () => {
    const task = makeTask();
    await writeTask(tmpDir, task);

    const { delegation, event } = createDelegation({
      taskId: task.id,
      runId: "run_001",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:001",
      task: "Task A",
    });
    await appendDelegationToTask(tmpDir, task.id, delegation, event);

    const result = await readTaskDelegations(tmpDir, task.id);
    expect(result).toBeDefined();
    expect(result!.task.id).toBe(task.id);
    expect(result!.delegations).toHaveLength(1);
  });

  it("returns empty delegations for task without delegations", async () => {
    const task = makeTask();
    await writeTask(tmpDir, task);

    const result = await readTaskDelegations(tmpDir, task.id);
    expect(result).toBeDefined();
    expect(result!.delegations).toHaveLength(0);
  });

  it("returns undefined for non-existent task", async () => {
    const result = await readTaskDelegations(tmpDir, "task_nonexistent");
    expect(result).toBeUndefined();
  });
});

describe("full lifecycle persistence", () => {
  it("tracks spawned → running → completed → verified", async () => {
    const task = makeTask();
    await writeTask(tmpDir, task);

    // 1. Spawn delegation
    const { delegation, event: spawnEvent } = createDelegation({
      taskId: task.id,
      runId: "run_lifecycle",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:lifecycle",
      task: "Full lifecycle test",
    });
    await appendDelegationToTask(tmpDir, task.id, delegation, spawnEvent);

    // 2. spawned → running
    const runResult = updateDelegation(delegation, { status: "running" });
    expect(runResult.ok).toBe(true);
    if (!runResult.ok) return;
    await updateDelegationInTask(tmpDir, task.id, runResult.delegation, runResult.event);

    // 3. running → completed
    const completeResult = updateDelegation(runResult.delegation, {
      status: "completed",
      resultSnapshot: { content: "Result data", outcomeStatus: "ok" },
    });
    expect(completeResult.ok).toBe(true);
    if (!completeResult.ok) return;
    await updateDelegationInTask(tmpDir, task.id, completeResult.delegation, completeResult.event);

    // 4. completed → verified
    const verifyResult = updateDelegation(completeResult.delegation, {
      status: "verified",
      verificationNote: "Looks good",
    });
    expect(verifyResult.ok).toBe(true);
    if (!verifyResult.ok) return;
    await updateDelegationInTask(tmpDir, task.id, verifyResult.delegation, verifyResult.event);

    // Verify final state
    const final = await readTask(tmpDir, task.id);
    expect(final!.delegations).toHaveLength(1);
    expect(final!.delegations![0].status).toBe("verified");
    expect(final!.delegations![0].resultSnapshot?.content).toBe("Result data");
    expect(final!.delegations![0].verificationNote).toBe("Looks good");
    expect(final!.delegationEvents).toHaveLength(4);
    expect(final!.delegationSummary!.verified).toBe(1);
    expect(final!.delegationSummary!.allSettled).toBe(true);
  });

  it("tracks failed → retrying → spawned lifecycle", async () => {
    const task = makeTask();
    await writeTask(tmpDir, task);

    // 1. Spawn
    const { delegation, event: spawnEvent } = createDelegation({
      taskId: task.id,
      runId: "run_retry",
      targetAgentId: "seum",
      targetSessionKey: "agent:seum:subagent:retry",
      task: "Retry lifecycle test",
    });
    await appendDelegationToTask(tmpDir, task.id, delegation, spawnEvent);

    // 2. spawned → running
    const runResult = updateDelegation(delegation, { status: "running" });
    expect(runResult.ok).toBe(true);
    if (!runResult.ok) return;
    await updateDelegationInTask(tmpDir, task.id, runResult.delegation, runResult.event);

    // 3. running → failed
    const failResult = updateDelegation(runResult.delegation, {
      status: "failed",
      error: "timeout error",
    });
    expect(failResult.ok).toBe(true);
    if (!failResult.ok) return;
    await updateDelegationInTask(tmpDir, task.id, failResult.delegation, failResult.event);

    // 4. failed → retrying
    const retryResult = updateDelegation(failResult.delegation, { status: "retrying" });
    expect(retryResult.ok).toBe(true);
    if (!retryResult.ok) return;
    await updateDelegationInTask(tmpDir, task.id, retryResult.delegation, retryResult.event);

    // 5. retrying → spawned (new attempt)
    const respawnResult = updateDelegation(retryResult.delegation, { status: "spawned" });
    expect(respawnResult.ok).toBe(true);
    if (!respawnResult.ok) return;
    await updateDelegationInTask(tmpDir, task.id, respawnResult.delegation, respawnResult.event);

    // Verify state
    const final = await readTask(tmpDir, task.id);
    expect(final!.delegations![0].status).toBe("spawned");
    expect(final!.delegations![0].retryCount).toBe(1);
    expect(final!.delegations![0].previousErrors).toEqual(["timeout error"]);
    expect(final!.delegationEvents).toHaveLength(5);
  });
});
