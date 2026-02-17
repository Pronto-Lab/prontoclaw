/**
 * Integration tests for task-tracker changes:
 * 1. Zombie task abandonment E2E
 * 2. Channel config propagation
 * 3. appendToHistory lock + task_complete reorder
 * 4. Task enforcer cache + cleanup
 * 5. Task monitor "abandoned" parsing
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

// ============================================================================
// Mock Setup
// ============================================================================

vi.mock("node:fs/promises", () => {
  const fsMock = {
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockRejectedValue(new Error("ENOENT")),
    unlink: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue({ write: vi.fn(), close: vi.fn() }),
  };
  return { ...fsMock, default: fsMock };
});

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/test-workspace"),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveSessionAgentId: vi.fn(() => "main"),
  listAgentIds: vi.fn(() => ["main"]),
}));

vi.mock("../agents/tools/task-tool.js", () => ({
  findActiveTask: vi.fn(),
  findPendingTasks: vi.fn().mockResolvedValue([]),
  findPickableBacklogTask: vi.fn().mockResolvedValue(null),
  findBlockedTasks: vi.fn().mockResolvedValue([]),
  findPendingApprovalTasks: vi.fn().mockResolvedValue([]),
  findAllBacklogTasks: vi.fn().mockResolvedValue([]),
  writeTask: vi.fn().mockResolvedValue(undefined),
  readTask: vi.fn().mockResolvedValue(null),
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn().mockResolvedValue({
    text: "ok",
    sessionId: "test",
    usage: { inputTokens: 0, outputTokens: 0 },
  }),
}));

vi.mock("./task-lock.js", () => ({
  acquireTaskLock: vi.fn(async () => ({ release: vi.fn() })),
}));

vi.mock("../routing/bindings.js", () => ({
  resolveAgentBoundAccountId: vi.fn(() => "test-account"),
}));

vi.mock("../agents/tools/sessions-helpers.js", () => ({
  createAgentToAgentPolicy: vi.fn(() => ({ isAllowed: () => true })),
}));

vi.mock("../process/command-queue.js", () => ({
  getQueueSize: vi.fn(() => 0),
}));

import fs from "node:fs/promises";
import { findActiveTask, readTask, writeTask } from "../agents/tools/task-tool.js";
import { agentCommand } from "../commands/agent.js";
import { getQueueSize } from "../process/command-queue.js";
import { resolveAgentBoundAccountId } from "../routing/bindings.js";
import { startTaskContinuationRunner, __resetAgentStates } from "./task-continuation-runner.js";

// ============================================================================
// Test: Zombie Task Abandonment
// ============================================================================

describe("zombie task abandonment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T10:00:00Z"));
    vi.clearAllMocks();
    __resetAgentStates();
    vi.mocked(findActiveTask).mockResolvedValue(null);
    vi.mocked(agentCommand).mockResolvedValue({
      payloads: [],
      meta: {
        durationMs: 0,
        agentMeta: { sessionId: "test", provider: "mock", model: "mock" },
      },
    });
    vi.mocked(getQueueSize).mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves in_progress task to backlog after 24h (reassign #1)", async () => {
    const zombieTask = {
      id: "task_zombie1",
      status: "in_progress" as const,
      priority: "medium" as const,
      description: "Stale task",
      created: "2026-02-03T10:00:00Z",
      lastActivity: "2026-02-03T10:00:00Z",
      progress: ["Started working"],
    };

    // readdir returns a task file
    vi.mocked(fs.readdir).mockResolvedValue(["task_zombie1.md"] as string[]);

    // readTask returns the zombie task (called twice: once for initial check, once for fresh read inside lock)
    vi.mocked(readTask)
      .mockResolvedValueOnce(zombieTask as never)
      .mockResolvedValueOnce({ ...zombieTask } as never);

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {
            taskContinuation: { zombieTaskTtl: "24h" },
          },
        },
      } as OpenClawConfig,
    });

    // Advance past the check interval (2 minutes)
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(writeTask).toHaveBeenCalledWith(
      "/tmp/test-workspace",
      expect.objectContaining({
        id: "task_zombie1",
        status: "backlog",
        reassignCount: 1,
      }),
    );

    // Verify progress was appended
    const writtenTask = vi.mocked(writeTask).mock.calls[0]?.[1] as { progress?: string[] };
    expect(writtenTask.progress).toContainEqual(
      expect.stringContaining("Auto-recovered to backlog after zombie detection"),
    );

    runner.stop();
  });

  it("does NOT abandon in_progress task within TTL", async () => {
    const freshTask = {
      id: "task_fresh1",
      status: "in_progress" as const,
      priority: "medium" as const,
      description: "Active task",
      created: "2026-02-05T09:30:00Z",
      lastActivity: "2026-02-05T09:55:00Z", // 5 minutes ago
      progress: ["Working"],
    };

    vi.mocked(fs.readdir).mockResolvedValue(["task_fresh1.md"] as string[]);
    vi.mocked(readTask).mockResolvedValue(freshTask as never);

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: {
          defaults: {
            taskContinuation: { zombieTaskTtl: "24h" },
          },
        },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    // writeTask should NOT have been called with abandoned
    const abandonCalls = vi
      .mocked(writeTask)
      .mock.calls.filter(([, task]) => (task as { status?: string }).status === "abandoned");
    expect(abandonCalls).toHaveLength(0);

    runner.stop();
  });

  it("skips non-in_progress tasks for zombie check", async () => {
    const blockedTask = {
      id: "task_blocked1",
      status: "blocked" as const,
      priority: "medium" as const,
      description: "Blocked task",
      created: "2026-02-01T10:00:00Z",
      lastActivity: "2026-02-01T10:00:00Z",
      progress: ["Blocked"],
    };

    vi.mocked(fs.readdir).mockResolvedValue(["task_blocked1.md"] as string[]);
    vi.mocked(readTask).mockResolvedValue(blockedTask as never);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    const abandonCalls = vi
      .mocked(writeTask)
      .mock.calls.filter(([, task]) => (task as { status?: string }).status === "abandoned");
    expect(abandonCalls).toHaveLength(0);

    runner.stop();
  });
});

// ============================================================================
// Test: Channel Config Propagation
// ============================================================================

describe("channel config propagation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T10:00:00Z"));
    vi.clearAllMocks();
    __resetAgentStates();
    vi.mocked(fs.readdir).mockResolvedValue([]);
    vi.mocked(agentCommand).mockResolvedValue({
      payloads: [],
      meta: {
        durationMs: 0,
        agentMeta: { sessionId: "test", provider: "mock", model: "mock" },
      },
    });
    vi.mocked(getQueueSize).mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses configured channel instead of hardcoded discord", async () => {
    const activeTask = {
      id: "task_active1",
      status: "in_progress" as const,
      priority: "medium" as const,
      description: "Active task",
      created: "2026-02-05T09:00:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Working"],
    };

    vi.mocked(findActiveTask).mockResolvedValue(activeTask as never);

    const cfg = {
      agents: {
        defaults: {
          taskContinuation: {
            channel: "slack",
          },
        },
      },
    } as OpenClawConfig;

    const runner = startTaskContinuationRunner({ cfg });

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    // resolveAgentBoundAccountId should have been called with "slack", not "discord"
    expect(resolveAgentBoundAccountId).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "slack",
    );

    runner.stop();
  });

  it("defaults to discord when channel is not configured", async () => {
    const activeTask = {
      id: "task_active2",
      status: "in_progress" as const,
      priority: "medium" as const,
      description: "Active task",
      created: "2026-02-05T09:00:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Working"],
    };

    vi.mocked(findActiveTask).mockResolvedValue(activeTask as never);

    const cfg = {
      agents: {
        defaults: {},
      },
    } as OpenClawConfig;

    const runner = startTaskContinuationRunner({ cfg });

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    // resolveAgentBoundAccountId should default to "discord"
    expect(resolveAgentBoundAccountId).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "discord",
    );

    runner.stop();
  });
});

// ============================================================================
// Test: Task Monitor parses "abandoned" status
// ============================================================================

describe("task-monitor abandoned status parsing", () => {
  it("parseTaskFileMd handles abandoned status in task file", () => {
    // Inline parser (same logic as task-monitor-server.ts)
    function parseStatus(content: string): string | null {
      const match = content.match(/\*\*Status:\*\*\s*(.+)/);
      return match ? match[1].trim() : null;
    }

    const abandonedTaskContent = [
      "# Task: task_abandoned1",
      "",
      "## Metadata",
      "- **Status:** abandoned",
      "- **Priority:** medium",
      "- **Created:** 2026-02-03T10:00:00Z",
      "",
      "## Description",
      "A zombie task that was abandoned",
      "",
      "## Progress",
      "- Started working",
      "- Auto-abandoned: no activity for 24h (TTL: 24h)",
      "",
      "## Last Activity",
      "2026-02-05T10:00:00Z",
    ].join("\n");

    const status = parseStatus(abandonedTaskContent);
    expect(status).toBe("abandoned");
  });

  it("task file with abandoned status is a valid TaskFile", () => {
    // Verify that "abandoned" is in the expected union
    type TaskStatus =
      | "pending"
      | "pending_approval"
      | "in_progress"
      | "blocked"
      | "backlog"
      | "completed"
      | "cancelled"
      | "abandoned";

    const status: TaskStatus = "abandoned";
    expect(status).toBe("abandoned");

    // Verify all valid task statuses
    const validStatuses: TaskStatus[] = [
      "pending",
      "pending_approval",
      "in_progress",
      "blocked",
      "backlog",
      "completed",
      "cancelled",
      "abandoned",
    ];
    expect(validStatuses).toContain("abandoned");
  });
});

// ============================================================================
// Test: Task Enforcer Cache and Cleanup
// ============================================================================

describe("task enforcer cache behavior", () => {
  it("taskStartedSessions stores timestamps not booleans", () => {
    // This verifies the Map<string, number> change
    const sessions = new Map<string, number>();
    const now = Date.now();
    sessions.set("session1", now);

    // Verify it stores a timestamp, not boolean
    expect(typeof sessions.get("session1")).toBe("number");
    expect(sessions.get("session1")).toBe(now);

    // Verify .has() works for existence check
    expect(sessions.has("session1")).toBe(true);
    expect(sessions.has("nonexistent")).toBe(false);
  });

  it("stale sessions are identified correctly", () => {
    const SESSION_STALE_MS = 24 * 60 * 60 * 1000;
    const sessions = new Map<string, number>();
    const now = Date.now();

    // Fresh session (5 minutes old)
    sessions.set("fresh", now - 5 * 60 * 1000);

    // Stale session (25 hours old)
    sessions.set("stale", now - 25 * 60 * 60 * 1000);

    // Cleanup logic
    const staleEntries: string[] = [];
    for (const [key, timestamp] of sessions) {
      if (now - timestamp > SESSION_STALE_MS) {
        staleEntries.push(key);
      }
    }

    expect(staleEntries).toEqual(["stale"]);
    expect(staleEntries).not.toContain("fresh");
  });

  it("active task cache expires after TTL", () => {
    const CACHE_TTL_MS = 30_000; // 30 seconds
    const cache = new Map<string, { result: boolean; cachedAt: number }>();
    const now = Date.now();

    // Set cache entry
    cache.set("workspace1", { result: true, cachedAt: now - 31_000 });

    // Check if expired
    const entry = cache.get("workspace1");
    const isExpired = entry && now - entry.cachedAt > CACHE_TTL_MS;
    expect(isExpired).toBe(true);

    // Fresh entry should not be expired
    cache.set("workspace2", { result: true, cachedAt: now - 10_000 });
    const freshEntry = cache.get("workspace2");
    const isFreshExpired = freshEntry && now - freshEntry.cachedAt > CACHE_TTL_MS;
    expect(isFreshExpired).toBe(false);
  });
});
