import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireTaskLock, type TaskLock } from "./task-lock.js";
import {
  type TaskFile,
  type TaskStep,
  writeTask,
  readTask,
  findActiveTask,
  findBlockedTasks,
  listTasks,
  getTasksDir,
} from "../agents/tools/task-file-io.js";
import { checkStopGuard } from "../agents/tools/task-stop-guard.js";
import { type TaskDelegation, type DelegationEvent, type DelegationSummary } from "../agents/tools/task-delegation-types.js";
import { A2AJobManager, STALE_JOB_THRESHOLD_MS } from "../agents/tools/a2a-job-manager.js";
import { A2AJobReaper } from "../agents/tools/a2a-job-reaper.js";
import { A2AConcurrencyGateImpl, A2AConcurrencyError, type A2AConcurrencyConfig } from "../agents/a2a-concurrency.js";

// ─── Test Fixture Helpers ───

function makeTask(overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    id: `task_${Math.random().toString(36).slice(2, 14)}`,
    status: "in_progress",
    priority: "medium",
    description: "Test coordination task",
    created: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    progress: ["Started"],
    ...overrides,
  };
}

function makeStep(
  status: "pending" | "in_progress" | "done" | "skipped",
  id?: string,
  content?: string,
): TaskStep {
  return {
    id: id ?? `step_${Math.random().toString(36).slice(2, 8)}`,
    content: content ?? `Step ${id ?? "auto"}`,
    status,
    order: 1,
  };
}

/**
 * Barrier synchronization for deterministic concurrency testing.
 * All participants call wait(), and all proceed simultaneously once
 * the required count is reached.
 */
function createBarrier(count: number): { wait: () => Promise<void> } {
  let arrived = 0;
  let resolveAll: (() => void) | null = null;
  const allArrived = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });

  return {
    wait: async () => {
      arrived++;
      if (arrived >= count) {
        resolveAll?.();
      }
      await allArrived;
    },
  };
}

// ─── Test Suite ───

describe("Coordination Invariants", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "coordination-test-"));
    // Ensure tasks directory exists for file I/O operations
    await fs.mkdir(path.join(tmpDir, "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── TC-01: Lock Contention ───
  describe("TC-01: Lock Contention", () => {
    it("10 concurrent lock acquisitions — exactly 1 succeeds", async () => {
      const taskId = "task_lock_contention_test";
      const N = 10;
      const barrier = createBarrier(N);

      const results = await Promise.allSettled(
        Array.from({ length: N }, async (_, i) => {
          await barrier.wait();
          const lock = await acquireTaskLock(tmpDir, taskId);
          return { index: i, lock };
        }),
      );

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<{ index: number; lock: TaskLock | null }> =>
          r.status === "fulfilled",
      );

      // All attempts should fulfill (no exceptions thrown)
      expect(fulfilled).toHaveLength(N);

      const successes = fulfilled.filter((r) => r.value.lock !== null);
      const failures = fulfilled.filter((r) => r.value.lock === null);

      // Exactly 1 should acquire the lock
      expect(successes).toHaveLength(1);
      // Remaining 9 should gracefully fail (null return, not exception)
      expect(failures).toHaveLength(N - 1);

      // No rejected promises (no exceptions)
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(0);

      // Clean up: release the acquired lock
      await successes[0].value.lock!.release();
    });

    it("lock release allows next acquisition", async () => {
      const taskId = "task_lock_release_test";

      // First acquisition succeeds
      const lock1 = await acquireTaskLock(tmpDir, taskId);
      expect(lock1).not.toBeNull();

      // Second acquisition fails while lock held
      const lock2 = await acquireTaskLock(tmpDir, taskId);
      expect(lock2).toBeNull();

      // Release first lock
      await lock1!.release();

      // Third acquisition succeeds after release
      const lock3 = await acquireTaskLock(tmpDir, taskId);
      expect(lock3).not.toBeNull();

      await lock3!.release();
    });

    it("concurrent lock-release cycles maintain mutual exclusion", async () => {
      const taskId = "task_cycle_test";
      const N = 5;
      let concurrentHolders = 0;
      let maxConcurrentHolders = 0;

      // Each worker: acquire → increment → delay → decrement → release
      // If mutual exclusion holds, maxConcurrentHolders should be 1
      const workers = Array.from({ length: N }, async () => {
        // Retry loop to simulate contention
        for (let attempt = 0; attempt < 20; attempt++) {
          const lock = await acquireTaskLock(tmpDir, taskId);
          if (lock) {
            concurrentHolders++;
            maxConcurrentHolders = Math.max(maxConcurrentHolders, concurrentHolders);

            // Simulate work
            await new Promise((r) => setTimeout(r, 5));

            concurrentHolders--;
            await lock.release();
            return true;
          }
          // Brief pause before retry
          await new Promise((r) => setTimeout(r, 2));
        }
        return false; // Didn't get lock in time
      });

      const results = await Promise.all(workers);

      // All workers should eventually get the lock
      // (not guaranteed due to timing, but at least some should succeed)
      const successCount = results.filter(Boolean).length;
      expect(successCount).toBeGreaterThan(0);

      // Critical invariant: never more than 1 concurrent holder
      expect(maxConcurrentHolders).toBe(1);
    });
  });

  // ─── TC-02: Block → Resume Roundtrip ───
  describe("TC-02: Block → Resume Roundtrip", () => {
    it("task transitions in_progress → blocked → in_progress preserving data", async () => {
      // Create and write an in_progress task
      const task = makeTask({
        status: "in_progress",
        description: "Implement feature X",
        progress: ["Started work"],
        steps: [
          makeStep("done", "s1", "Setup environment"),
          makeStep("in_progress", "s2", "Write implementation"),
          makeStep("pending", "s3", "Write tests"),
        ],
      });

      await writeTask(tmpDir, task);

      // Verify initial state
      const initial = await readTask(tmpDir, task.id);
      expect(initial).not.toBeNull();
      expect(initial!.status).toBe("in_progress");

      // Simulate block
      task.status = "blocked";
      task.blockedReason = "Need API key from agent-b";
      task.unblockedBy = ["agent-b"];
      task.unblockedAction = "Provide API key";
      task.unblockRequestCount = 0;
      task.escalationState = "none";
      task.lastActivity = new Date().toISOString();
      task.progress.push("[BLOCKED] Need API key from agent-b");
      await writeTask(tmpDir, task);

      // Verify blocked state
      const blocked = await readTask(tmpDir, task.id);
      expect(blocked).not.toBeNull();
      expect(blocked!.status).toBe("blocked");
      expect(blocked!.blockedReason).toBe("Need API key from agent-b");
      expect(blocked!.unblockedBy).toEqual(["agent-b"]);

      const blockedTasks = await findBlockedTasks(tmpDir);
      expect(blockedTasks).toHaveLength(1);
      expect(blockedTasks[0].id).toBe(task.id);

      // Simulate resume
      task.status = "in_progress";
      task.lastActivity = new Date().toISOString();
      task.progress.push("Task resumed from blocked state");
      task.blockedReason = undefined;
      task.unblockedBy = undefined;
      task.unblockedAction = undefined;
      task.unblockRequestCount = undefined;
      task.lastUnblockerIndex = undefined;
      task.escalationState = undefined;
      await writeTask(tmpDir, task);

      // Verify resumed state
      const resumed = await readTask(tmpDir, task.id);
      expect(resumed).not.toBeNull();
      expect(resumed!.status).toBe("in_progress");
      expect(resumed!.blockedReason).toBeUndefined();
      expect(resumed!.unblockedBy).toBeUndefined();

      // Verify steps survived the roundtrip
      expect(resumed!.steps).toHaveLength(3);
      expect(resumed!.steps![0].status).toBe("done");
      expect(resumed!.steps![1].status).toBe("in_progress");
      expect(resumed!.steps![2].status).toBe("pending");

      // Verify progress history accumulated
      expect(resumed!.progress).toHaveLength(3);
      expect(resumed!.progress[0]).toBe("Started work");
      expect(resumed!.progress[1]).toContain("BLOCKED");
      expect(resumed!.progress[2]).toBe("Task resumed from blocked state");
    });

    it("multiple block-resume cycles preserve task integrity", async () => {
      const task = makeTask({
        status: "in_progress",
        description: "Multi-cycle task",
        progress: ["Started"],
      });

      await writeTask(tmpDir, task);

      for (let cycle = 0; cycle < 3; cycle++) {
        // Block
        task.status = "blocked";
        task.blockedReason = `Blocked cycle ${cycle}`;
        task.unblockedBy = ["agent-helper"];
        task.progress.push(`[BLOCKED] Cycle ${cycle}`);
        await writeTask(tmpDir, task);

        const blocked = await readTask(tmpDir, task.id);
        expect(blocked!.status).toBe("blocked");

        // Resume
        task.status = "in_progress";
        task.blockedReason = undefined;
        task.unblockedBy = undefined;
        task.progress.push(`Resumed cycle ${cycle}`);
        await writeTask(tmpDir, task);

        const resumed = await readTask(tmpDir, task.id);
        expect(resumed!.status).toBe("in_progress");
      }

      // Verify all progress entries accumulated
      const final = await readTask(tmpDir, task.id);
      // 1 (initial) + 3 cycles * 2 (block + resume) = 7
      expect(final!.progress).toHaveLength(7);
      expect(final!.description).toBe("Multi-cycle task");
    });
  });

  // ─── TC-03: Duplicate Complete Prevention (Stop Guard) ───
  describe("TC-03: Duplicate Complete Prevention", () => {
    it("stop guard blocks completion when steps are incomplete", () => {
      const task = makeTask({
        steps: [
          makeStep("done", "s1", "Setup"),
          makeStep("in_progress", "s2", "Implementation"),
          makeStep("pending", "s3", "Tests"),
        ],
      });

      const result = checkStopGuard(task);
      expect(result.blocked).toBe(true);
      expect(result.incompleteSteps).toHaveLength(2);
      expect(result.incompleteSteps!.map((s) => s.id)).toContain("s2");
      expect(result.incompleteSteps!.map((s) => s.id)).toContain("s3");
    });

    it("stop guard allows completion when all steps done/skipped", () => {
      const task = makeTask({
        steps: [
          makeStep("done", "s1", "Setup"),
          makeStep("done", "s2", "Implementation"),
          makeStep("skipped", "s3", "Optional tests"),
        ],
      });

      const result = checkStopGuard(task);
      expect(result.blocked).toBe(false);
    });

    it("concurrent complete attempts — only one can hold lock", async () => {
      const task = makeTask({
        steps: [
          makeStep("done", "s1"),
          makeStep("done", "s2"),
        ],
      });
      await writeTask(tmpDir, task);

      const N = 5;
      const barrier = createBarrier(N);

      // Simulate 5 concurrent task_complete attempts
      const results = await Promise.allSettled(
        Array.from({ length: N }, async (_, i) => {
          await barrier.wait();

          const lock = await acquireTaskLock(tmpDir, task.id);
          if (!lock) {
            return { index: i, result: "lock_failed" as const };
          }

          try {
            // Re-read fresh task (like task_complete does)
            const fresh = await readTask(tmpDir, task.id);
            if (!fresh) {
              return { index: i, result: "task_gone" as const };
            }

            // Check stop guard
            const guard = checkStopGuard(fresh);
            if (guard.blocked) {
              return { index: i, result: "guard_blocked" as const };
            }

            // Already completed?
            if (fresh.status === "completed") {
              return { index: i, result: "already_completed" as const };
            }

            // Complete the task
            fresh.status = "completed";
            fresh.outcome = { kind: "completed", summary: `Completed by worker ${i}` };
            await writeTask(tmpDir, fresh);

            return { index: i, result: "completed" as const };
          } finally {
            await lock.release();
          }
        }),
      );

      const fulfilled = results.filter(
        (r) => r.status === "fulfilled",
      ) as PromiseFulfilledResult<{ index: number; result: string }>[];

      expect(fulfilled).toHaveLength(N);

      const completed = fulfilled.filter((r) => r.value.result === "completed");
      const lockFailed = fulfilled.filter((r) => r.value.result === "lock_failed");

      // Exactly 1 should complete the task
      expect(completed).toHaveLength(1);
      // Rest should fail to acquire lock
      expect(lockFailed).toHaveLength(N - 1);

      // Verify task is completed
      const finalTask = await readTask(tmpDir, task.id);
      expect(finalTask!.status).toBe("completed");
      expect(finalTask!.outcome?.kind).toBe("completed");
    });

    it("stop guard blocks even with force_complete=false semantics", () => {
      // Task with ALL steps pending — maximum block
      const steps: TaskStep[] = Array.from({ length: 5 }, (_, i) =>
        makeStep("pending", `s${i}`, `Step ${i}`),
      );

      const task = makeTask({ steps });
      const result = checkStopGuard(task);

      expect(result.blocked).toBe(true);
      expect(result.incompleteSteps).toHaveLength(5);
      expect(result.reason).toContain("5 steps still incomplete");
    });
  });

  // ─── TC-04: Session Isolation ───
  describe("TC-04: Session Isolation", () => {
    let agentADir: string;
    let agentBDir: string;

    beforeEach(async () => {
      agentADir = path.join(tmpDir, "agent-a-workspace");
      agentBDir = path.join(tmpDir, "agent-b-workspace");
      await fs.mkdir(path.join(agentADir, "tasks"), { recursive: true });
      await fs.mkdir(path.join(agentBDir, "tasks"), { recursive: true });
    });

    it("agent workspaces are fully isolated — no cross-contamination", async () => {
      // Agent A writes its task
      const taskA = makeTask({
        id: "task_agent_a_001",
        description: "Agent A's task",
        status: "in_progress",
        progress: ["Agent A started"],
      });
      await writeTask(agentADir, taskA);

      // Agent B writes its task
      const taskB = makeTask({
        id: "task_agent_b_001",
        description: "Agent B's task",
        status: "blocked",
        blockedReason: "Waiting for something",
        progress: ["Agent B started"],
      });
      await writeTask(agentBDir, taskB);

      // Agent A can only see its own task
      const agentATasks = await listTasks(agentADir);
      expect(agentATasks).toHaveLength(1);
      expect(agentATasks[0].id).toBe("task_agent_a_001");
      expect(agentATasks[0].status).toBe("in_progress");

      // Agent B can only see its own task
      const agentBTasks = await listTasks(agentBDir);
      expect(agentBTasks).toHaveLength(1);
      expect(agentBTasks[0].id).toBe("task_agent_b_001");
      expect(agentBTasks[0].status).toBe("blocked");

      // Agent A has no blocked tasks
      const agentABlocked = await findBlockedTasks(agentADir);
      expect(agentABlocked).toHaveLength(0);

      // Agent B has no active (in_progress) task
      const agentBActive = await findActiveTask(agentBDir);
      expect(agentBActive).toBeNull();

      // Agent A has active task
      const agentAActive = await findActiveTask(agentADir);
      expect(agentAActive).not.toBeNull();
      expect(agentAActive!.id).toBe("task_agent_a_001");

      // Agent B has blocked task
      const agentBBlocked = await findBlockedTasks(agentBDir);
      expect(agentBBlocked).toHaveLength(1);
      expect(agentBBlocked[0].id).toBe("task_agent_b_001");
    });

    it("lock in agent A workspace does not affect agent B", async () => {
      const sharedTaskId = "task_shared_name";

      // Agent A locks a task
      const lockA = await acquireTaskLock(agentADir, sharedTaskId);
      expect(lockA).not.toBeNull();

      // Agent B can lock the same task ID in its own workspace
      const lockB = await acquireTaskLock(agentBDir, sharedTaskId);
      expect(lockB).not.toBeNull();

      // Both locks are independent
      await lockA!.release();
      await lockB!.release();
    });

    it("concurrent writes to different agent workspaces don't interfere", async () => {
      const N = 10;
      const barrier = createBarrier(N * 2);

      // N tasks in each workspace, written concurrently
      const writes = [
        ...Array.from({ length: N }, async (_, i) => {
          await barrier.wait();
          const task = makeTask({
            id: `task_a_${String(i).padStart(3, "0")}`,
            description: `Agent A task ${i}`,
            status: "in_progress",
          });
          await writeTask(agentADir, task);
          return { agent: "A", index: i };
        }),
        ...Array.from({ length: N }, async (_, i) => {
          await barrier.wait();
          const task = makeTask({
            id: `task_b_${String(i).padStart(3, "0")}`,
            description: `Agent B task ${i}`,
            status: "in_progress",
          });
          await writeTask(agentBDir, task);
          return { agent: "B", index: i };
        }),
      ];

      await Promise.all(writes);

      // Verify counts
      const agentATasks = await listTasks(agentADir);
      const agentBTasks = await listTasks(agentBDir);

      expect(agentATasks).toHaveLength(N);
      expect(agentBTasks).toHaveLength(N);

      // Verify no cross-contamination
      for (const t of agentATasks) {
        expect(t.id).toMatch(/^task_a_/);
      }
      for (const t of agentBTasks) {
        expect(t.id).toMatch(/^task_b_/);
      }
    });
  });

  // ─── TC-05: Gateway Restart — Task State Preservation (with Delegations) ───
  describe("TC-05: Task Persistence Across Restart", () => {
    it("task with steps and progress survives write → re-read cycle", async () => {
      const task = makeTask({
        status: "in_progress",
        description: "Persistent task",
        progress: ["Step 1 done", "Step 2 in progress"],
        steps: [
          makeStep("done", "s1", "Setup"),
          makeStep("in_progress", "s2", "Implement"),
          makeStep("pending", "s3", "Test"),
        ],
      });

      await writeTask(tmpDir, task);

      // Simulate "restart" — re-read from same dir (as gateway would on restart)
      const recovered = await readTask(tmpDir, task.id);
      expect(recovered).not.toBeNull();
      expect(recovered!.id).toBe(task.id);
      expect(recovered!.status).toBe("in_progress");
      expect(recovered!.description).toBe("Persistent task");
      expect(recovered!.progress).toEqual(["Step 1 done", "Step 2 in progress"]);
      expect(recovered!.steps).toHaveLength(3);
      expect(recovered!.steps![0].status).toBe("done");
      expect(recovered!.steps![1].status).toBe("in_progress");
      expect(recovered!.steps![2].status).toBe("pending");
    });

    it("task with delegations survives write → re-read cycle", async () => {
      const delegation: TaskDelegation = {
        delegationId: "delegation_test_001",
        runId: "run_abc123",
        targetAgentId: "agent-b",
        targetSessionKey: "session-b",
        task: "Implement feature X",
        label: "Feature X",
        status: "running",
        retryCount: 0,
        maxRetries: 3,
        previousErrors: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const event: DelegationEvent = {
        type: "delegation_spawned",
        delegationId: "delegation_test_001",
        runId: "run_abc123",
        timestamp: Date.now(),
      };

      const delegationSummary: DelegationSummary = {
        total: 1,
        completed: 0,
        verified: 0,
        failed: 0,
        running: 1,
        allSettled: false,
      };

      const task = makeTask({
        status: "in_progress",
        description: "Task with delegations",
        delegations: [delegation],
        delegationEvents: [event],
        delegationSummary,
      });

      await writeTask(tmpDir, task);

      // Re-read (simulating restart)
      const recovered = await readTask(tmpDir, task.id);
      expect(recovered).not.toBeNull();
      expect(recovered!.delegations).toHaveLength(1);
      expect(recovered!.delegations![0].delegationId).toBe("delegation_test_001");
      expect(recovered!.delegations![0].runId).toBe("run_abc123");
      expect(recovered!.delegations![0].status).toBe("running");
      expect(recovered!.delegations![0].targetAgentId).toBe("agent-b");
      expect(recovered!.delegationEvents).toHaveLength(1);
      expect(recovered!.delegationEvents![0].type).toBe("delegation_spawned");
      expect(recovered!.delegationSummary).toBeDefined();
      expect(recovered!.delegationSummary!.total).toBe(1);
      expect(recovered!.delegationSummary!.running).toBe(1);
      expect(recovered!.delegationSummary!.allSettled).toBe(false);
    });

    it("multiple tasks survive restart and listing still works", async () => {
      // Write 5 tasks with different statuses
      const tasks = [
        makeTask({ id: "task_persist_001", status: "in_progress" }),
        makeTask({ id: "task_persist_002", status: "completed", outcome: { kind: "completed", summary: "Done" } }),
        makeTask({ id: "task_persist_003", status: "blocked", blockedReason: "Waiting" }),
        makeTask({ id: "task_persist_004", status: "in_progress" }),
        makeTask({ id: "task_persist_005", status: "completed", outcome: { kind: "completed", summary: "Also done" } }),
      ];

      for (const t of tasks) {
        await writeTask(tmpDir, t);
      }

      // Re-read all via listTasks
      const listed = await listTasks(tmpDir);
      expect(listed).toHaveLength(5);

      // Verify statuses preserved
      const statusMap = new Map(listed.map((t) => [t.id, t.status]));
      expect(statusMap.get("task_persist_001")).toBe("in_progress");
      expect(statusMap.get("task_persist_002")).toBe("completed");
      expect(statusMap.get("task_persist_003")).toBe("blocked");
      expect(statusMap.get("task_persist_004")).toBe("in_progress");
      expect(statusMap.get("task_persist_005")).toBe("completed");

      // findActiveTask should find one of the in_progress tasks
      const active = await findActiveTask(tmpDir);
      expect(active).not.toBeNull();
      expect(active!.status).toBe("in_progress");

      // findBlockedTasks should find the blocked one
      const blocked = await findBlockedTasks(tmpDir);
      expect(blocked).toHaveLength(1);
      expect(blocked[0].id).toBe("task_persist_003");
    });
  });

  // ─── TC-06: A2A Durability — Job Recovery After Restart ───
  describe("TC-06: A2A Job Durability & Recovery", () => {
    let jobsDir: string;

    beforeEach(async () => {
      jobsDir = path.join(tmpDir, "a2a-jobs-test");
    });

    type JobParams = {
      jobId: string;
      targetSessionKey: string;
      displayKey: string;
      message: string;
      conversationId: string;
      maxPingPongTurns: number;
      announceTimeoutMs: number;
      requesterSessionKey?: string;
      taskId?: string;
      workSessionId?: string;
      parentConversationId?: string;
      depth?: number;
      hop?: number;
      skipPingPong?: boolean;
    };

    function makeJobParams(overrides: Partial<JobParams> = {}): JobParams {
      return {
        jobId: `job_${Math.random().toString(36).slice(2, 10)}`,
        targetSessionKey: "session-target",
        displayKey: "Agent B",
        message: "Hello from A",
        conversationId: `conv_${Math.random().toString(36).slice(2, 8)}`,
        maxPingPongTurns: 10,
        announceTimeoutMs: 30000,
        ...overrides,
      };
    }

    it("jobs persist to disk and survive manager re-instantiation", async () => {
      // Create manager, write some jobs
      const manager1 = new A2AJobManager(jobsDir);
      await manager1.init();

      await manager1.createJob(makeJobParams({ jobId: "job_persist_1" }));
      await manager1.createJob(makeJobParams({ jobId: "job_persist_2" }));

      // Transition job1 to RUNNING
      await manager1.updateStatus("job_persist_1", "RUNNING");

      // "Restart" — create a NEW manager instance pointing to same directory
      const manager2 = new A2AJobManager(jobsDir);
      await manager2.init();

      // Both jobs should be readable
      const readJob1 = await manager2.readJob("job_persist_1");
      const readJob2 = await manager2.readJob("job_persist_2");

      expect(readJob1).not.toBeNull();
      expect(readJob1!.status).toBe("RUNNING");
      expect(readJob1!.jobId).toBe("job_persist_1");

      expect(readJob2).not.toBeNull();
      expect(readJob2!.status).toBe("PENDING");
      expect(readJob2!.jobId).toBe("job_persist_2");

      // getIncompleteJobs should find both
      const incomplete = await manager2.getIncompleteJobs();
      expect(incomplete).toHaveLength(2);
    });

    it("reaper abandons stale RUNNING jobs and resets recent RUNNING to PENDING", async () => {
      const manager = new A2AJobManager(jobsDir);
      await manager.init();

      // Create a stale RUNNING job (updatedAt > 1 hour ago)
      await manager.createJob(makeJobParams({ jobId: "job_stale" }));
      await manager.updateStatus("job_stale", "RUNNING");
      // Manually backdate the updatedAt to make it stale
      const staleRecord = await manager.readJob("job_stale");
      staleRecord!.updatedAt = Date.now() - STALE_JOB_THRESHOLD_MS - 60_000; // 1 hour + 1 min ago
      // Write the backdated record directly via the file system
      const staleFilePath = path.join(jobsDir, "job-job_stale.json");
      await fs.writeFile(staleFilePath, JSON.stringify(staleRecord, null, 2), "utf-8");

      // Create a recent RUNNING job (updatedAt is recent)
      await manager.createJob(makeJobParams({ jobId: "job_recent" }));
      await manager.updateStatus("job_recent", "RUNNING");

      // Create a PENDING job (should stay PENDING)
      await manager.createJob(makeJobParams({ jobId: "job_pending" }));

      // Run reaper
      const reaper = new A2AJobReaper(manager);
      const result = await reaper.runOnStartup();

      expect(result.totalIncomplete).toBe(3);
      expect(result.abandoned).toBe(1);       // stale → ABANDONED
      expect(result.resetToPending).toBe(1);  // recent RUNNING → PENDING

      // Verify states
      const staleAfter = await manager.readJob("job_stale");
      expect(staleAfter!.status).toBe("ABANDONED");
      expect(staleAfter!.finishedAt).toBeDefined();

      const recentAfter = await manager.readJob("job_recent");
      expect(recentAfter!.status).toBe("PENDING");
      expect(recentAfter!.resumeCount).toBe(1);

      const pendingAfter = await manager.readJob("job_pending");
      expect(pendingAfter!.status).toBe("PENDING");
      expect(pendingAfter!.resumeCount).toBe(0); // untouched
    });

    it("reaper getResumableJobs returns only PENDING jobs after recovery", async () => {
      const manager = new A2AJobManager(jobsDir);
      await manager.init();

      // Setup: 1 stale RUNNING, 1 recent RUNNING, 2 PENDING, 1 COMPLETED
      await manager.createJob(makeJobParams({ jobId: "job_r1" }));
      await manager.updateStatus("job_r1", "RUNNING");
      const r1 = await manager.readJob("job_r1");
      r1!.updatedAt = Date.now() - STALE_JOB_THRESHOLD_MS - 60_000;
      await fs.writeFile(path.join(jobsDir, "job-job_r1.json"), JSON.stringify(r1, null, 2), "utf-8");

      await manager.createJob(makeJobParams({ jobId: "job_r2" }));
      await manager.updateStatus("job_r2", "RUNNING");

      await manager.createJob(makeJobParams({ jobId: "job_p1" }));
      await manager.createJob(makeJobParams({ jobId: "job_p2" }));

      await manager.createJob(makeJobParams({ jobId: "job_c1" }));
      await manager.completeJob("job_c1");

      const reaper = new A2AJobReaper(manager);
      await reaper.runOnStartup();

      const resumable = await reaper.getResumableJobs();
      // job_r1 → ABANDONED (not resumable)
      // job_r2 → PENDING (resumable)
      // job_p1, job_p2 → PENDING (resumable)
      // job_c1 → COMPLETED (not resumable)
      expect(resumable).toHaveLength(3);
      const ids = resumable.map((j) => j.jobId).sort();
      expect(ids).toEqual(["job_p1", "job_p2", "job_r2"]);
    });
  });

  // ─── TC-07: A2A Concurrency Gate Limits ───
  describe("TC-07: A2A Concurrency Gate", () => {
    it("respects maxConcurrentFlows limit with queuing", async () => {
      const config: A2AConcurrencyConfig = { maxConcurrentFlows: 2, queueTimeoutMs: 5000 };
      const gate = new A2AConcurrencyGateImpl(config);
      const agentId = "agent-test";

      // Acquire 2 permits — both should succeed immediately
      await gate.acquire(agentId, "flow-1");
      await gate.acquire(agentId, "flow-2");

      expect(gate.activeCount(agentId)).toBe(2);
      expect(gate.queuedCount(agentId)).toBe(0);

      // Third acquire should queue (not resolve until release)
      let flow3Acquired = false;
      const flow3Promise = gate.acquire(agentId, "flow-3").then(() => {
        flow3Acquired = true;
      });

      // Give the event loop a tick
      await new Promise((r) => setTimeout(r, 10));

      expect(flow3Acquired).toBe(false);
      expect(gate.queuedCount(agentId)).toBe(1);

      // Release one permit — flow-3 should proceed
      gate.release(agentId, "flow-1");

      await flow3Promise;
      expect(flow3Acquired).toBe(true);
      expect(gate.activeCount(agentId)).toBe(2); // flow-2 + flow-3
      expect(gate.queuedCount(agentId)).toBe(0);

      // Cleanup
      gate.release(agentId, "flow-2");
      gate.release(agentId, "flow-3");
      expect(gate.activeCount(agentId)).toBe(0);
    });

    it("5 concurrent acquires with limit 2 — 2 proceed, 3 queue, all eventually complete", async () => {
      const config: A2AConcurrencyConfig = { maxConcurrentFlows: 2, queueTimeoutMs: 5000 };
      const gate = new A2AConcurrencyGateImpl(config);
      const agentId = "agent-concurrent";
      const N = 5;

      const acquired: number[] = [];
      const promises: Promise<void>[] = [];

      for (let i = 0; i < N; i++) {
        promises.push(
          gate.acquire(agentId, `flow-${i}`).then(() => {
            acquired.push(i);
          }),
        );
      }

      // Let the event loop process immediate acquires
      await new Promise((r) => setTimeout(r, 10));

      // Exactly 2 should have acquired immediately
      expect(acquired).toHaveLength(2);
      expect(gate.activeCount(agentId)).toBe(2);
      expect(gate.queuedCount(agentId)).toBe(3);

      // Release all permits one by one, each should wake the next queued
      for (let i = 0; i < N; i++) {
        gate.release(agentId, `flow-${acquired[0]}`);
        acquired.shift();
        await new Promise((r) => setTimeout(r, 10));
      }

      // All 5 should have been acquired at some point
      await Promise.all(promises);
      expect(gate.activeCount(agentId)).toBe(0);
      expect(gate.queuedCount(agentId)).toBe(0);
    });

    it("queue timeout fires A2AConcurrencyError", async () => {
      const config: A2AConcurrencyConfig = { maxConcurrentFlows: 1, queueTimeoutMs: 100 };
      const gate = new A2AConcurrencyGateImpl(config);
      const agentId = "agent-timeout";

      // Acquire the only permit
      await gate.acquire(agentId, "flow-holder");
      expect(gate.activeCount(agentId)).toBe(1);

      // Second acquire should timeout after 100ms
      await expect(gate.acquire(agentId, "flow-waiter")).rejects.toThrow(A2AConcurrencyError);

      // Verify the error has correct properties
      try {
        await gate.acquire(agentId, "flow-waiter-2");
      } catch (err) {
        expect(err).toBeInstanceOf(A2AConcurrencyError);
        const concErr = err as A2AConcurrencyError;
        expect(concErr.agentId).toBe(agentId);
        expect(concErr.queueTimeoutMs).toBe(100);
      }

      // After timeout, queued count should be 0
      expect(gate.queuedCount(agentId)).toBe(0);

      // Release and verify cleanup
      gate.release(agentId, "flow-holder");
      expect(gate.activeCount(agentId)).toBe(0);
    });

    it("different agents have independent concurrency limits", async () => {
      const config: A2AConcurrencyConfig = { maxConcurrentFlows: 1, queueTimeoutMs: 5000 };
      const gate = new A2AConcurrencyGateImpl(config);

      // Agent A acquires its only slot
      await gate.acquire("agent-a", "flow-a1");
      expect(gate.activeCount("agent-a")).toBe(1);

      // Agent B can also acquire — independent limit
      await gate.acquire("agent-b", "flow-b1");
      expect(gate.activeCount("agent-b")).toBe(1);

      // Agent A is at limit, but Agent B is unaffected
      expect(gate.queuedCount("agent-a")).toBe(0);
      expect(gate.queuedCount("agent-b")).toBe(0);

      gate.release("agent-a", "flow-a1");
      gate.release("agent-b", "flow-b1");
    });
  });
});
