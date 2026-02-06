import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startTaskContinuationRunner, __resetAgentStates } from "./task-continuation-runner.js";
import type { TaskFile } from "../agents/tools/task-tool.js";

vi.mock("../agents/tools/task-tool.js", () => ({
  findActiveTask: vi.fn(),
  findPendingTasks: vi.fn(),
  findBlockedTasks: vi.fn(),
  writeTask: vi.fn(),
  readTask: vi.fn(),
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn(),
}));

vi.mock("../process/command-queue.js", () => ({
  getQueueSize: vi.fn(() => 0),
}));

vi.mock("../routing/bindings.js", () => ({
  resolveAgentBoundAccountId: vi.fn(() => "test-account"),
}));

import { findBlockedTasks, writeTask } from "../agents/tools/task-tool.js";
import { agentCommand } from "../commands/agent.js";
import { getQueueSize } from "../process/command-queue.js";

describe("Task Unblock with escalationState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T10:00:00Z"));
    vi.clearAllMocks();
    __resetAgentStates();
    vi.mocked(findBlockedTasks).mockResolvedValue([]);
    vi.mocked(agentCommand).mockResolvedValue({
      text: "ok",
      sessionId: "test",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    vi.mocked(getQueueSize).mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes escalationState to none when task is blocked", () => {
    const task: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_2"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    expect(task.escalationState).toBe("none");
    expect(task.unblockRequestCount).toBe(0);
  });

  it("transitions escalationState to requesting on first unblock request", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_2"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {},
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_2", name: "Agent 2" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        escalationState: "requesting",
        unblockRequestCount: 1,
      }),
    );

    runner.stop();
  });

  it("keeps escalationState as requesting on subsequent attempts", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_2"],
      unblockRequestCount: 1,
      escalationState: "requesting",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {},
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_2", name: "Agent 2" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        escalationState: "requesting",
        unblockRequestCount: 2,
      }),
    );

    runner.stop();
  });

  it("transitions escalationState to failed when max requests reached", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_2"],
      unblockRequestCount: 3,
      escalationState: "requesting",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {},
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_2", name: "Agent 2" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        escalationState: "failed",
        unblockRequestCount: 3,
      }),
    );

    runner.stop();
  });

  it("treats undefined escalationState as none for backwards compatibility", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_2"],
      unblockRequestCount: 0,
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {},
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_2", name: "Agent 2" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        escalationState: "requesting",
        unblockRequestCount: 1,
      }),
    );

    runner.stop();
  });
});
