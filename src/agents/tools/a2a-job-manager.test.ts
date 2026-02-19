import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { A2AJobManager, STALE_JOB_THRESHOLD_MS, type A2AJobRecord } from "./a2a-job-manager.js";

function makeJobParams(overrides: Partial<A2AJobRecord> = {}): Omit<A2AJobRecord, "status" | "createdAt" | "updatedAt" | "currentTurn" | "resumeCount"> {
  return {
    jobId: `run-${Math.random().toString(36).slice(2, 10)}`,
    targetSessionKey: "agent:eden:main",
    displayKey: "eden",
    message: "Test message",
    conversationId: `conv-${Math.random().toString(36).slice(2, 10)}`,
    maxPingPongTurns: 3,
    announceTimeoutMs: 30000,
    ...overrides,
  };
}

describe("A2AJobManager", () => {
  let tmpDir: string;
  let jobsDir: string;
  let manager: A2AJobManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-job-test-"));
    jobsDir = path.join(tmpDir, "a2a-jobs");
    manager = new A2AJobManager(jobsDir);
    await manager.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("creates the jobs directory", async () => {
      const stat = await fs.stat(jobsDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("is idempotent", async () => {
      await manager.init();
      await manager.init();
      const stat = await fs.stat(jobsDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe("createJob", () => {
    it("creates a job file in PENDING status", async () => {
      const params = makeJobParams({ jobId: "run-test123" });
      const job = await manager.createJob(params);

      expect(job.status).toBe("PENDING");
      expect(job.jobId).toBe("run-test123");
      expect(job.currentTurn).toBe(0);
      expect(job.resumeCount).toBe(0);
      expect(job.createdAt).toBeGreaterThan(0);

      // Verify file exists
      const filePath = path.join(jobsDir, "job-run-test123.json");
      const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
      expect(content.status).toBe("PENDING");
      expect(content.targetSessionKey).toBe("agent:eden:main");
    });

    it("preserves all params", async () => {
      const params = makeJobParams({
        jobId: "run-full",
        requesterSessionKey: "agent:ruda:main",
        taskId: "task_abc",
        workSessionId: "ws_xyz",
        depth: 2,
        hop: 1,
        skipPingPong: true,
      });
      const job = await manager.createJob(params);

      expect(job.requesterSessionKey).toBe("agent:ruda:main");
      expect(job.taskId).toBe("task_abc");
      expect(job.workSessionId).toBe("ws_xyz");
      expect(job.depth).toBe(2);
      expect(job.hop).toBe(1);
      expect(job.skipPingPong).toBe(true);
    });
  });

  describe("readJob", () => {
    it("reads an existing job", async () => {
      const params = makeJobParams({ jobId: "run-read" });
      await manager.createJob(params);

      const job = await manager.readJob("run-read");
      expect(job).not.toBeNull();
      expect(job!.jobId).toBe("run-read");
    });

    it("returns null for non-existent job", async () => {
      const job = await manager.readJob("run-nonexistent");
      expect(job).toBeNull();
    });
  });

  describe("updateStatus", () => {
    it("transitions PENDING → RUNNING", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-status" }));
      const updated = await manager.updateStatus("run-status", "RUNNING");

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("RUNNING");
      expect(updated!.updatedAt).toBeGreaterThan(updated!.createdAt - 1);
    });

    it("transitions RUNNING → COMPLETED with finishedAt", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-complete" }));
      await manager.updateStatus("run-complete", "RUNNING");
      const completed = await manager.updateStatus("run-complete", "COMPLETED", {
        finishedAt: Date.now(),
      });

      expect(completed!.status).toBe("COMPLETED");
      expect(completed!.finishedAt).toBeGreaterThan(0);
    });

    it("records lastError on FAILED", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-fail" }));
      await manager.updateStatus("run-fail", "RUNNING");
      const failed = await manager.updateStatus("run-fail", "FAILED", {
        lastError: "Connection timeout",
        finishedAt: Date.now(),
      });

      expect(failed!.status).toBe("FAILED");
      expect(failed!.lastError).toBe("Connection timeout");
    });

    it("returns null for non-existent job", async () => {
      const result = await manager.updateStatus("run-nope", "RUNNING");
      expect(result).toBeNull();
    });
  });

  describe("recordTurnProgress", () => {
    it("updates currentTurn", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-turn" }));
      await manager.recordTurnProgress("run-turn", 3);

      const job = await manager.readJob("run-turn");
      expect(job!.currentTurn).toBe(3);
    });

    it("ignores non-existent job", async () => {
      // Should not throw
      await manager.recordTurnProgress("run-nope", 5);
    });
  });

  describe("completeJob / failJob / abandonJob", () => {
    it("completeJob sets COMPLETED + finishedAt", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-c" }));
      await manager.completeJob("run-c");

      const job = await manager.readJob("run-c");
      expect(job!.status).toBe("COMPLETED");
      expect(job!.finishedAt).toBeGreaterThan(0);
    });

    it("failJob sets FAILED + error + finishedAt", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-f" }));
      await manager.failJob("run-f", "Out of memory");

      const job = await manager.readJob("run-f");
      expect(job!.status).toBe("FAILED");
      expect(job!.lastError).toBe("Out of memory");
      expect(job!.finishedAt).toBeGreaterThan(0);
    });

    it("abandonJob sets ABANDONED + finishedAt", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-a" }));
      await manager.abandonJob("run-a");

      const job = await manager.readJob("run-a");
      expect(job!.status).toBe("ABANDONED");
      expect(job!.finishedAt).toBeGreaterThan(0);
    });
  });

  describe("getIncompleteJobs", () => {
    it("returns only PENDING and RUNNING jobs", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-pending" }));
      await manager.createJob(makeJobParams({ jobId: "run-running" }));
      await manager.updateStatus("run-running", "RUNNING");
      await manager.createJob(makeJobParams({ jobId: "run-done" }));
      await manager.completeJob("run-done");
      await manager.createJob(makeJobParams({ jobId: "run-failed" }));
      await manager.failJob("run-failed", "error");

      const incomplete = await manager.getIncompleteJobs();
      const ids = incomplete.map((j) => j.jobId).sort();

      expect(ids).toEqual(["run-pending", "run-running"]);
    });

    it("returns empty when no incomplete jobs", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-done" }));
      await manager.completeJob("run-done");

      const incomplete = await manager.getIncompleteJobs();
      expect(incomplete).toHaveLength(0);
    });
  });

  describe("getAllJobs", () => {
    it("returns all jobs regardless of status", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-1" }));
      await manager.createJob(makeJobParams({ jobId: "run-2" }));
      await manager.completeJob("run-2");
      await manager.createJob(makeJobParams({ jobId: "run-3" }));
      await manager.failJob("run-3", "err");

      const all = await manager.getAllJobs();
      expect(all).toHaveLength(3);
    });
  });

  describe("deleteJob", () => {
    it("removes the job file", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-del" }));
      await manager.deleteJob("run-del");

      const job = await manager.readJob("run-del");
      expect(job).toBeNull();
    });

    it("does not throw for non-existent job", async () => {
      await manager.deleteJob("run-nonexistent");
    });
  });

  describe("cleanupFinishedJobs", () => {
    it("deletes finished jobs older than 7 days", async () => {
      // Create a completed job with old finishedAt
      const params = makeJobParams({ jobId: "run-old" });
      await manager.createJob(params);
      const job = await manager.readJob("run-old");
      job!.status = "COMPLETED";
      job!.finishedAt = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
      // Manually write to simulate old job
      const filePath = path.join(jobsDir, "job-run-old.json");
      await fs.writeFile(filePath, JSON.stringify(job), "utf-8");

      const cleaned = await manager.cleanupFinishedJobs();
      expect(cleaned).toBe(1);

      const deleted = await manager.readJob("run-old");
      expect(deleted).toBeNull();
    });

    it("preserves recent finished jobs", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-recent" }));
      await manager.completeJob("run-recent");

      const cleaned = await manager.cleanupFinishedJobs();
      expect(cleaned).toBe(0);

      const job = await manager.readJob("run-recent");
      expect(job).not.toBeNull();
    });

    it("preserves incomplete jobs", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-active" }));
      await manager.updateStatus("run-active", "RUNNING");

      const cleaned = await manager.cleanupFinishedJobs();
      expect(cleaned).toBe(0);
    });
  });

  describe("isStale", () => {
    it("returns false for non-RUNNING jobs", () => {
      const job: A2AJobRecord = {
        jobId: "run-1",
        status: "PENDING",
        targetSessionKey: "t",
        displayKey: "d",
        message: "m",
        conversationId: "c",
        maxPingPongTurns: 3,
        currentTurn: 0,
        announceTimeoutMs: 30000,
        createdAt: 0,
        updatedAt: 0,
        resumeCount: 0,
      };
      expect(manager.isStale(job)).toBe(false);
    });

    it("returns false for recently updated RUNNING job", () => {
      const job: A2AJobRecord = {
        jobId: "run-1",
        status: "RUNNING",
        targetSessionKey: "t",
        displayKey: "d",
        message: "m",
        conversationId: "c",
        maxPingPongTurns: 3,
        currentTurn: 0,
        announceTimeoutMs: 30000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resumeCount: 0,
      };
      expect(manager.isStale(job)).toBe(false);
    });

    it("returns true for old RUNNING job", () => {
      const job: A2AJobRecord = {
        jobId: "run-1",
        status: "RUNNING",
        targetSessionKey: "t",
        displayKey: "d",
        message: "m",
        conversationId: "c",
        maxPingPongTurns: 3,
        currentTurn: 0,
        announceTimeoutMs: 30000,
        createdAt: 0,
        updatedAt: Date.now() - STALE_JOB_THRESHOLD_MS - 1000,
        resumeCount: 0,
      };
      expect(manager.isStale(job)).toBe(true);
    });
  });

  describe("atomic write safety", () => {
    it("concurrent writes to different jobs don't interfere", async () => {
      const N = 10;
      const writes = Array.from({ length: N }, (_, i) =>
        manager.createJob(makeJobParams({ jobId: `run-concurrent-${i}` })),
      );
      await Promise.all(writes);

      const all = await manager.getAllJobs();
      expect(all).toHaveLength(N);
    });
  });
});
