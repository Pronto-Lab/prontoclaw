import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskFile } from "../agents/tools/task-tool.js";
import type { OpenClawConfig } from "../config/config.js";
import { startTaskContinuationRunner, __resetAgentStates } from "./task-continuation-runner.js";

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/test-workspace"),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../agents/tools/task-tool.js", () => ({
  findActiveTask: vi.fn(),
  findPendingTasks: vi.fn(),
  findPickableBacklogTask: vi.fn(),
  findBlockedTasks: vi.fn(),
  findPendingApprovalTasks: vi.fn(),
  findAllBacklogTasks: vi.fn(),
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

vi.mock("./task-lock.js", () => ({
  acquireTaskLock: vi.fn(async () => ({
    release: vi.fn(async () => {}),
  })),
}));
vi.mock("../agents/tools/sessions-helpers.js", () => ({
  createAgentToAgentPolicy: vi.fn((cfg: OpenClawConfig) => {
    const policy = cfg.agents?.defaults?.agentToAgent?.policy ?? "allow-all";
    return {
      isAllowed: (_from: string, _to: string) => {
        if (policy === "deny-all") {
          return false;
        }
        if (policy === "allow-all") {
          return true;
        }
        return true;
      },
    };
  }),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  },
}));

import {
  findActiveTask,
  findPendingTasks,
  findPickableBacklogTask,
  findBlockedTasks,
  findPendingApprovalTasks,
  writeTask,
  readTask,
} from "../agents/tools/task-tool.js";
import { agentCommand } from "../commands/agent.js";
import { getQueueSize } from "../process/command-queue.js";

describe("Task Unblock with escalationState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T10:00:00Z"));
    vi.clearAllMocks();
    __resetAgentStates();
    vi.mocked(findBlockedTasks).mockResolvedValue([]);
    vi.mocked(findActiveTask).mockResolvedValue(null);
    vi.mocked(findPendingTasks).mockResolvedValue([]);
    vi.mocked(findPendingApprovalTasks).mockResolvedValue([]);
    vi.mocked(findPickableBacklogTask).mockResolvedValue(null);
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
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

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
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

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
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

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
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

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

describe("Task Unblock Rotation", () => {
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

  it("rotates through unblockedBy array A→B→C→A", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_a", "agent_b", "agent_c"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {},
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_a", name: "Agent A" },
            { id: "agent_b", name: "Agent B" },
            { id: "agent_c", name: "Agent C" },
          ],
        },
      } as OpenClawConfig,
    });

    // First request - should go to agent_a (index 0)
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_a",
      }),
    );
    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lastUnblockerIndex: 0,
        unblockRequestCount: 1,
      }),
    );

    // Update task for next iteration
    blockedTask.unblockRequestCount = 1;
    blockedTask.lastUnblockerIndex = 0;
    blockedTask.lastActivity = "2026-02-05T10:31:00Z";
    blockedTask.lastUnblockRequestAt = "2026-02-05T10:31:00Z";
    blockedTask.escalationState = "requesting";
    vi.clearAllMocks();

    // Second request - should go to agent_b (index 1)
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_b",
      }),
    );
    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lastUnblockerIndex: 1,
        unblockRequestCount: 2,
      }),
    );

    // Update task for next iteration
    blockedTask.unblockRequestCount = 2;
    blockedTask.lastUnblockerIndex = 1;
    blockedTask.lastActivity = "2026-02-05T11:02:00Z";
    blockedTask.lastUnblockRequestAt = "2026-02-05T11:02:00Z";
    vi.clearAllMocks();

    // Third request - should go to agent_c (index 2)
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_c",
      }),
    );
    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lastUnblockerIndex: 2,
        unblockRequestCount: 3,
      }),
    );

    runner.stop();
  });

  it("persists lastUnblockerIndex to TaskFile", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_a", "agent_b"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {},
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_a", name: "Agent A" },
            { id: "agent_b", name: "Agent B" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lastUnblockerIndex: 0,
      }),
    );

    runner.stop();
  });

  it("starts at index 0 when lastUnblockerIndex is undefined", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_a", "agent_b", "agent_c"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {},
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_a", name: "Agent A" },
            { id: "agent_b", name: "Agent B" },
            { id: "agent_c", name: "Agent C" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_a",
      }),
    );
    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lastUnblockerIndex: 0,
      }),
    );

    runner.stop();
  });

  it("clamps index if unblockedBy array shrinks", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_a"],
      unblockRequestCount: 0,
      escalationState: "none",
      lastUnblockerIndex: 5,
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {},
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_a", name: "Agent A" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_a",
      }),
    );
    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lastUnblockerIndex: 0,
      }),
    );

    runner.stop();
  });

  it("always uses the same element for single-element array", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_a"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {},
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_a", name: "Agent A" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_a",
      }),
    );

    blockedTask.unblockRequestCount = 1;
    blockedTask.lastUnblockerIndex = 0;
    blockedTask.lastActivity = "2026-02-05T10:31:00Z";
    blockedTask.escalationState = "requesting";
    vi.clearAllMocks();

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_a",
      }),
    );

    runner.stop();
  });
});

describe("Task Unblock A2A Policy", () => {
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

  it("skips unblocker when A2A policy denies request", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_a", "agent_b"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {
            agentToAgent: {
              policy: "deny-all",
            },
          },
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_a", name: "Agent A" },
            { id: "agent_b", name: "Agent B" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(agentCommand).not.toHaveBeenCalled();

    runner.stop();
  });

  it("policy denial does not count as request attempt", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_a"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {
            agentToAgent: {
              policy: "deny-all",
            },
          },
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_a", name: "Agent A" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        unblockRequestCount: 0,
        escalationState: "failed",
      }),
    );

    runner.stop();
  });

  it("proceeds with request when A2A policy allows", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_a"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {
            agentToAgent: {
              policy: "allow-all",
            },
          },
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_a", name: "Agent A" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_a",
      }),
    );
    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        unblockRequestCount: 1,
        escalationState: "requesting",
      }),
    );

    runner.stop();
  });

  it("sets escalationState to failed when all unblockers denied by policy", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_a", "agent_b", "agent_c"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {
            agentToAgent: {
              policy: "deny-all",
            },
          },
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_a", name: "Agent A" },
            { id: "agent_b", name: "Agent B" },
            { id: "agent_c", name: "Agent C" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(agentCommand).not.toHaveBeenCalled();
    expect(writeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        escalationState: "failed",
        unblockRequestCount: 0,
      }),
    );

    runner.stop();
  });

  it("continues rotation when policy denies one unblocker but allows another", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting for help"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_a", "agent_b"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockImplementation(async (_dir, id) =>
      id === blockedTask.id ? blockedTask : null,
    );

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {
            agentToAgent: {
              policy: "allow-all",
            },
          },
          list: [
            { id: "main", name: "Main Agent" },
            { id: "agent_a", name: "Agent A" },
            { id: "agent_b", name: "Agent B" },
          ],
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_a",
      }),
    );

    blockedTask.unblockRequestCount = 1;
    blockedTask.lastUnblockerIndex = 0;
    blockedTask.lastActivity = "2026-02-05T10:31:00Z";
    blockedTask.escalationState = "requesting";
    vi.clearAllMocks();

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_b",
      }),
    );

    runner.stop();
  });
});

describe("Task Unblock Race Condition Handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T10:00:00Z"));
    vi.clearAllMocks();
    __resetAgentStates();
    vi.mocked(findBlockedTasks).mockResolvedValue([]);
    vi.mocked(readTask).mockResolvedValue(null);
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

  it("skips task when status changed after lock acquired", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_2"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockResolvedValue({
      ...blockedTask,
      status: "in_progress",
    });

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

    expect(agentCommand).not.toHaveBeenCalled();
    expect(writeTask).not.toHaveBeenCalled();

    runner.stop();
  });

  it("skips task when deleted after lock acquired", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_2"],
      unblockRequestCount: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockResolvedValue(null);

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

    expect(agentCommand).not.toHaveBeenCalled();
    runner.stop();
  });
});

describe("Task Unblock Failure Tracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T10:00:00Z"));
    vi.clearAllMocks();
    __resetAgentStates();
    vi.mocked(findBlockedTasks).mockResolvedValue([]);
    vi.mocked(getQueueSize).mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("increments unblockRequestFailures on agentCommand failure", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_2"],
      unblockRequestCount: 0,
      unblockRequestFailures: 0,
      escalationState: "none",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockImplementation(async () => JSON.parse(JSON.stringify(blockedTask)));
    vi.mocked(agentCommand).mockRejectedValue(new Error("Network error"));

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
        unblockRequestFailures: 1,
      }),
    );

    runner.stop();
  });

  it("sets escalationState to failed after max consecutive failures", async () => {
    const blockedTask: TaskFile = {
      id: "task_123",
      status: "blocked",
      priority: "high",
      description: "Test task",
      created: "2026-02-05T10:00:00Z",
      lastActivity: "2026-02-05T10:00:00Z",
      progress: ["[BLOCKED] Waiting"],
      blockedReason: "Needs help",
      unblockedBy: ["agent_2"],
      unblockRequestCount: 0,
      unblockRequestFailures: 2,
      escalationState: "requesting",
    };

    vi.mocked(findBlockedTasks).mockResolvedValue([blockedTask]);
    vi.mocked(readTask).mockImplementation(async () => JSON.parse(JSON.stringify(blockedTask)));
    vi.mocked(agentCommand).mockRejectedValue(new Error("Network error"));

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
        unblockRequestFailures: 3,
        escalationState: "failed",
      }),
    );

    runner.stop();
  });
});
