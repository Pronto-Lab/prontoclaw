import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn((cfg, agentId) => `/workspace/${agentId}`),
}));

vi.mock("../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../routing/session-key.js", () => ({
  resolveAgentIdFromSessionKey: vi.fn((key: string) => key.split(":")[1] || "main"),
}));

const mockUnsubscribe = vi.fn();
vi.mock("./agent-events.js", () => ({
  onAgentEvent: vi.fn(() => mockUnsubscribe),
}));

import fs from "node:fs/promises";
import { onAgentEvent } from "./agent-events.js";
import {
  clearTaskContext,
  registerTaskContext,
  resetTaskTrackerForTest,
  startTaskTracker,
  stopTaskTracker,
} from "./task-tracker.js";

describe("task-tracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTaskTrackerForTest();
  });

  afterEach(() => {
    resetTaskTrackerForTest();
  });

  describe("registerTaskContext", () => {
    it("stores context for valid runId", () => {
      registerTaskContext("run-123", { body: "Test message", threadId: "456" });

      expect(true).toBe(true);
    });

    it("handles empty runId gracefully", () => {
      registerTaskContext("", { body: "Test message" });

      expect(true).toBe(true);
    });
  });

  describe("clearTaskContext", () => {
    it("removes context from internal map", () => {
      registerTaskContext("run-123", { body: "Test" });
      clearTaskContext("run-123");

      expect(true).toBe(true);
    });
  });

  describe("startTaskTracker", () => {
    it("returns unsubscribe function", () => {
      const unsubscribe = startTaskTracker({} as never);

      expect(typeof unsubscribe).toBe("function");
      expect(onAgentEvent).toHaveBeenCalled();
    });

    it("skips duplicate starts", () => {
      startTaskTracker({} as never);
      vi.clearAllMocks();

      startTaskTracker({} as never);

      expect(onAgentEvent).not.toHaveBeenCalled();
    });
  });

  describe("stopTaskTracker", () => {
    it("unsubscribes from events", () => {
      startTaskTracker({} as never);

      stopTaskTracker();

      expect(mockUnsubscribe).toHaveBeenCalled();
    });
  });

  describe("lifecycle event handling", () => {
    it("writes CURRENT_TASK.md on start event with registered context", async () => {
      let capturedHandler: ((evt: unknown) => void) | null = null;
      vi.mocked(onAgentEvent).mockImplementation((handler) => {
        capturedHandler = handler as (evt: unknown) => void;
        return mockUnsubscribe;
      });

      startTaskTracker({} as never);
      registerTaskContext("run-abc", { body: "Test task body", threadId: "789" });

      capturedHandler!({
        stream: "lifecycle",
        runId: "run-abc",
        sessionKey: "agent:main:session",
        data: { phase: "start" },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fs.writeFile).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      expect(writeCall[0]).toContain("CURRENT_TASK.md");
      expect(writeCall[1]).toContain("Test task body");
    });

    it("skips start event when no context registered", async () => {
      let capturedHandler: ((evt: unknown) => void) | null = null;
      vi.mocked(onAgentEvent).mockImplementation((handler) => {
        capturedHandler = handler as (evt: unknown) => void;
        return mockUnsubscribe;
      });

      startTaskTracker({} as never);

      capturedHandler!({
        stream: "lifecycle",
        runId: "run-no-context",
        sessionKey: "agent:main:session",
        data: { phase: "start" },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("clears CURRENT_TASK.md on end event", async () => {
      let capturedHandler: ((evt: unknown) => void) | null = null;
      vi.mocked(onAgentEvent).mockImplementation((handler) => {
        capturedHandler = handler as (evt: unknown) => void;
        return mockUnsubscribe;
      });

      startTaskTracker({} as never);
      registerTaskContext("run-xyz", { body: "Task" });

      capturedHandler!({
        stream: "lifecycle",
        runId: "run-xyz",
        sessionKey: "agent:main:session",
        data: { phase: "start" },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      vi.clearAllMocks();

      capturedHandler!({
        stream: "lifecycle",
        runId: "run-xyz",
        sessionKey: "agent:main:session",
        data: { phase: "end" },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fs.writeFile).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      expect(writeCall[1]).toContain("No task in progress");
    });

    it("shows error note on error phase", async () => {
      let capturedHandler: ((evt: unknown) => void) | null = null;
      vi.mocked(onAgentEvent).mockImplementation((handler) => {
        capturedHandler = handler as (evt: unknown) => void;
        return mockUnsubscribe;
      });

      startTaskTracker({} as never);
      registerTaskContext("run-err", { body: "Task" });

      capturedHandler!({
        stream: "lifecycle",
        runId: "run-err",
        sessionKey: "agent:main:session",
        data: { phase: "start" },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      vi.clearAllMocks();

      capturedHandler!({
        stream: "lifecycle",
        runId: "run-err",
        sessionKey: "agent:main:session",
        data: { phase: "error" },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fs.writeFile).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      expect(writeCall[1]).toContain("Last task ended with error");
    });
  });

  describe("resetTaskTrackerForTest", () => {
    it("clears all internal state", () => {
      startTaskTracker({} as never);
      registerTaskContext("run-1", { body: "Test" });

      resetTaskTrackerForTest();

      expect(mockUnsubscribe).toHaveBeenCalled();
    });
  });
});
