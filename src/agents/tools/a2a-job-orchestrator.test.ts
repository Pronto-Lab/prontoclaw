import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initA2AJobManager, getA2AJobManager, resetA2AJobManager } from "./a2a-job-manager.js";

// Mock the flow execution
vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: vi.fn().mockResolvedValue(undefined),
}));

// Mock the logger
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createAndStartFlow, resumeFlows } from "./a2a-job-orchestrator.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const mockedRunFlow = vi.mocked(runSessionsSendA2AFlow);

describe("A2A Job Orchestrator", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-orch-test-"));
    const manager = initA2AJobManager(tmpDir);
    await manager.init();
    mockedRunFlow.mockReset();
    mockedRunFlow.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    resetA2AJobManager();
    await new Promise((r) => setTimeout(r, 150));
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("createAndStartFlow", () => {
    it("creates a job file and starts the flow", async () => {
      const jobId = await createAndStartFlow({
        jobId: "test-job-1",
        targetSessionKey: "agent:worker:main",
        displayKey: "worker",
        message: "Hello worker",
        announceTimeoutMs: 60000,
        maxPingPongTurns: 3,
        requesterSessionKey: "agent:main:main",
        conversationId: "conv-1",
      });

      expect(jobId).toBe("test-job-1");

      // Wait a tick for the void promise to start
      await new Promise((r) => setTimeout(r, 50));

      // Job file should exist
      const manager = getA2AJobManager()!;
      const job = await manager.readJob("test-job-1");
      expect(job).not.toBeNull();
      // Status should be RUNNING or COMPLETED (flow runs quickly in mock)
      expect(["RUNNING", "COMPLETED"]).toContain(job!.status);

      // Flow should have been called
      expect(mockedRunFlow).toHaveBeenCalledOnce();
      const callArgs = mockedRunFlow.mock.calls[0][0];
      expect(callArgs.targetSessionKey).toBe("agent:worker:main");
      expect(callArgs.message).toBe("Hello worker");
      expect(callArgs.conversationId).toBe("conv-1");
      expect(callArgs.startTurn).toBe(0);
      expect(callArgs.onTurnComplete).toBeTypeOf("function");
      expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    });

    it("marks job as COMPLETED when flow succeeds", async () => {
      await createAndStartFlow({
        jobId: "test-success",
        targetSessionKey: "agent:worker:main",
        displayKey: "worker",
        message: "Do work",
        announceTimeoutMs: 60000,
        maxPingPongTurns: 3,
      });

      // Wait for async completion
      await new Promise((r) => setTimeout(r, 100));

      const manager = getA2AJobManager()!;
      const job = await manager.readJob("test-success");
      expect(job!.status).toBe("COMPLETED");
      expect(job!.finishedAt).toBeTypeOf("number");
    });

    it("marks job as FAILED when flow throws", async () => {
      mockedRunFlow.mockRejectedValueOnce(new Error("Connection lost"));

      await createAndStartFlow({
        jobId: "test-fail",
        targetSessionKey: "agent:worker:main",
        displayKey: "worker",
        message: "Do work",
        announceTimeoutMs: 60000,
        maxPingPongTurns: 3,
      });

      // Wait for async error handling
      await new Promise((r) => setTimeout(r, 100));

      const manager = getA2AJobManager()!;
      const job = await manager.readJob("test-fail");
      expect(job!.status).toBe("FAILED");
      expect(job!.lastError).toBe("Connection lost");
    });

    it("falls back to direct flow when manager not initialized", async () => {
      resetA2AJobManager();

      const jobId = await createAndStartFlow({
        jobId: "test-no-manager",
        targetSessionKey: "agent:worker:main",
        displayKey: "worker",
        message: "Fallback",
        announceTimeoutMs: 60000,
        maxPingPongTurns: 1,
      });

      expect(jobId).toBe("test-no-manager");

      // Wait for void to settle
      await new Promise((r) => setTimeout(r, 50));

      // Flow still called (just without durability)
      expect(mockedRunFlow).toHaveBeenCalledOnce();
      // No startTurn/signal/onTurnComplete in fallback
      const callArgs = mockedRunFlow.mock.calls[0][0];
      expect(callArgs.startTurn).toBeUndefined();
      expect(callArgs.signal).toBeUndefined();
      expect(callArgs.onTurnComplete).toBeUndefined();
    });

    it("persists all flow params into job record", async () => {
      await createAndStartFlow({
        jobId: "test-full-params",
        targetSessionKey: "agent:worker:main",
        displayKey: "worker",
        message: "Full params test",
        announceTimeoutMs: 120000,
        maxPingPongTurns: 5,
        requesterSessionKey: "agent:main:main",
        conversationId: "conv-full",
        taskId: "task-1",
        workSessionId: "ws-1",
        parentConversationId: "parent-conv",
        depth: 2,
        hop: 1,
        skipPingPong: true,
      });

      const manager = getA2AJobManager()!;
      const job = await manager.readJob("test-full-params");
      expect(job!.targetSessionKey).toBe("agent:worker:main");
      expect(job!.displayKey).toBe("worker");
      expect(job!.message).toBe("Full params test");
      expect(job!.announceTimeoutMs).toBe(120000);
      expect(job!.maxPingPongTurns).toBe(5);
      expect(job!.requesterSessionKey).toBe("agent:main:main");
      expect(job!.conversationId).toBe("conv-full");
      expect(job!.taskId).toBe("task-1");
      expect(job!.workSessionId).toBe("ws-1");
      expect(job!.parentConversationId).toBe("parent-conv");
      expect(job!.depth).toBe(2);
      expect(job!.hop).toBe(1);
      expect(job!.skipPingPong).toBe(true);
    });
  });

  describe("resumeFlows", () => {
    it("resumes PENDING jobs", async () => {
      const manager = getA2AJobManager()!;
      const job = await manager.createJob({
        jobId: "resume-1",
        targetSessionKey: "agent:worker:main",
        displayKey: "worker",
        message: "Resume me",
        conversationId: "conv-resume",
        maxPingPongTurns: 3,
        announceTimeoutMs: 60000,
      });
      // Simulate previous progress
      await manager.recordTurnProgress("resume-1", 2);

      const resumed = await resumeFlows([job]);

      expect(resumed).toBe(1);

      // Wait for async start
      await new Promise((r) => setTimeout(r, 50));

      expect(mockedRunFlow).toHaveBeenCalledOnce();
      const callArgs = mockedRunFlow.mock.calls[0][0];
      expect(callArgs.targetSessionKey).toBe("agent:worker:main");
      // startTurn should be 0 because createJob sets currentTurn to 0,
      // but we called recordTurnProgress(2), so the flow call uses job.currentTurn
      // which was 0 at time of creating the job snapshot passed to resumeFlows.
      // The actual job on disk has currentTurn=2 but the passed job object has 0.
      // This is fine — resumeFlows reads the job object as-is.
      expect(callArgs.startTurn).toBe(0); // from the passed job object
    });

    it("resumes multiple jobs", async () => {
      const manager = getA2AJobManager()!;
      const job1 = await manager.createJob({
        jobId: "multi-1",
        targetSessionKey: "agent:w1:main",
        displayKey: "w1",
        message: "Job 1",
        conversationId: "conv-m1",
        maxPingPongTurns: 2,
        announceTimeoutMs: 60000,
      });
      const job2 = await manager.createJob({
        jobId: "multi-2",
        targetSessionKey: "agent:w2:main",
        displayKey: "w2",
        message: "Job 2",
        conversationId: "conv-m2",
        maxPingPongTurns: 4,
        announceTimeoutMs: 90000,
      });

      const resumed = await resumeFlows([job1, job2]);

      expect(resumed).toBe(2);

      // Wait for async starts
      await new Promise((r) => setTimeout(r, 100));

      expect(mockedRunFlow).toHaveBeenCalledTimes(2);
    });

    it("handles zero jobs gracefully", async () => {
      const resumed = await resumeFlows([]);
      expect(resumed).toBe(0);
      expect(mockedRunFlow).not.toHaveBeenCalled();
    });
  });
});
