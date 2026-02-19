import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { A2AJobManager, STALE_JOB_THRESHOLD_MS, type A2AJobRecord } from "./a2a-job-manager.js";
import { A2AJobReaper } from "./a2a-job-reaper.js";

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

describe("A2AJobReaper", () => {
  let tmpDir: string;
  let jobsDir: string;
  let manager: A2AJobManager;
  let reaper: A2AJobReaper;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-reaper-test-"));
    jobsDir = path.join(tmpDir, "a2a-jobs");
    manager = new A2AJobManager(jobsDir);
    await manager.init();
    reaper = new A2AJobReaper(manager);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("runOnStartup", () => {
    it("no-op when no incomplete jobs", async () => {
      const result = await reaper.runOnStartup();
      expect(result.totalIncomplete).toBe(0);
      expect(result.resetToPending).toBe(0);
      expect(result.abandoned).toBe(0);
    });

    it("leaves PENDING jobs as-is", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-pending" }));

      const result = await reaper.runOnStartup();
      expect(result.totalIncomplete).toBe(1);
      expect(result.resetToPending).toBe(0);
      expect(result.abandoned).toBe(0);

      const job = await manager.readJob("run-pending");
      expect(job!.status).toBe("PENDING");
    });

    it("resets non-stale RUNNING jobs to PENDING", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-active" }));
      await manager.updateStatus("run-active", "RUNNING");

      const result = await reaper.runOnStartup();
      expect(result.resetToPending).toBe(1);

      const job = await manager.readJob("run-active");
      expect(job!.status).toBe("PENDING");
      expect(job!.resumeCount).toBe(1);
    });

    it("abandons stale RUNNING jobs (>1 hour)", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-stale" }));
      // Manually set old updatedAt to simulate stale job
      const job = await manager.readJob("run-stale");
      job!.status = "RUNNING";
      job!.updatedAt = Date.now() - STALE_JOB_THRESHOLD_MS - 5000;
      const filePath = path.join(jobsDir, "job-run-stale.json");
      await fs.writeFile(filePath, JSON.stringify(job), "utf-8");

      const result = await reaper.runOnStartup();
      expect(result.abandoned).toBe(1);

      const updated = await manager.readJob("run-stale");
      expect(updated!.status).toBe("ABANDONED");
      expect(updated!.finishedAt).toBeGreaterThan(0);
    });

    it("ignores COMPLETED and FAILED jobs", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-done" }));
      await manager.completeJob("run-done");
      await manager.createJob(makeJobParams({ jobId: "run-err" }));
      await manager.failJob("run-err", "error");

      const result = await reaper.runOnStartup();
      expect(result.totalIncomplete).toBe(0);
    });

    it("handles mixed job states correctly", async () => {
      // PENDING — should stay
      await manager.createJob(makeJobParams({ jobId: "run-p" }));

      // RUNNING non-stale — should reset to PENDING
      await manager.createJob(makeJobParams({ jobId: "run-r" }));
      await manager.updateStatus("run-r", "RUNNING");

      // RUNNING stale — should ABANDON
      await manager.createJob(makeJobParams({ jobId: "run-s" }));
      const staleJob = await manager.readJob("run-s");
      staleJob!.status = "RUNNING";
      staleJob!.updatedAt = Date.now() - STALE_JOB_THRESHOLD_MS - 1000;
      await fs.writeFile(
        path.join(jobsDir, "job-run-s.json"),
        JSON.stringify(staleJob),
        "utf-8",
      );

      // COMPLETED — should be ignored
      await manager.createJob(makeJobParams({ jobId: "run-c" }));
      await manager.completeJob("run-c");

      const result = await reaper.runOnStartup();
      expect(result.totalIncomplete).toBe(3); // p, r, s
      expect(result.resetToPending).toBe(1); // r
      expect(result.abandoned).toBe(1); // s

      expect((await manager.readJob("run-p"))!.status).toBe("PENDING");
      expect((await manager.readJob("run-r"))!.status).toBe("PENDING");
      expect((await manager.readJob("run-s"))!.status).toBe("ABANDONED");
      expect((await manager.readJob("run-c"))!.status).toBe("COMPLETED");
    });

    it("increments resumeCount on reset", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-resume" }));
      await manager.updateStatus("run-resume", "RUNNING");

      // First restart
      await reaper.runOnStartup();
      let job = await manager.readJob("run-resume");
      expect(job!.resumeCount).toBe(1);

      // Second restart — set back to RUNNING to simulate
      await manager.updateStatus("run-resume", "RUNNING");
      await reaper.runOnStartup();
      job = await manager.readJob("run-resume");
      expect(job!.resumeCount).toBe(2);
    });
  });

  describe("getResumableJobs", () => {
    it("returns only PENDING jobs", async () => {
      await manager.createJob(makeJobParams({ jobId: "run-p1" }));
      await manager.createJob(makeJobParams({ jobId: "run-p2" }));
      await manager.createJob(makeJobParams({ jobId: "run-r" }));
      await manager.updateStatus("run-r", "RUNNING");
      await manager.createJob(makeJobParams({ jobId: "run-c" }));
      await manager.completeJob("run-c");

      const resumable = await reaper.getResumableJobs();
      const ids = resumable.map((j) => j.jobId).sort();
      expect(ids).toEqual(["run-p1", "run-p2"]);
    });
  });
});
