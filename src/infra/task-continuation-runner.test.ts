import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startTaskContinuationRunner, __resetAgentStates } from "./task-continuation-runner.js";

vi.mock("../agents/tools/task-tool.js", () => ({
  findActiveTask: vi.fn(),
  findPendingTasks: vi.fn(),
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn(),
}));

vi.mock("../process/command-queue.js", () => ({
  getQueueSize: vi.fn(() => 0),
}));

import { findActiveTask, findPendingTasks } from "../agents/tools/task-tool.js";
import { agentCommand } from "../commands/agent.js";
import { getQueueSize } from "../process/command-queue.js";

describe("startTaskContinuationRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T10:00:00Z"));
    vi.clearAllMocks();
    __resetAgentStates();
    vi.mocked(findActiveTask).mockResolvedValue(null);
    vi.mocked(findPendingTasks).mockResolvedValue([]);
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

  it("starts and stops without error", () => {
    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });
    expect(runner).toBeDefined();
    runner.stop();
  });

  it("does not send prompt when no active task", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(null);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(agentCommand).not.toHaveBeenCalled();
    runner.stop();
  });

  it("sends continuation prompt for idle task", async () => {
    const idleTask = {
      id: "task_abc123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Fix the bug",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Started"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(idleTask);
    vi.mocked(findPendingTasks).mockResolvedValue([]);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("TASK CONTINUATION"),
        agentId: "main",
        deliver: false,
        quiet: true,
      }),
    );
    runner.stop();
  });

  it("respects cooldown between prompts", async () => {
    const idleTask = {
      id: "task_abc123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Fix the bug",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Started"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(idleTask);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(agentCommand).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(agentCommand).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(agentCommand).toHaveBeenCalledTimes(2);

    runner.stop();
  });

  it("skips when agent is busy", async () => {
    vi.mocked(getQueueSize).mockReturnValue(1);
    const idleTask = {
      id: "task_abc123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Fix the bug",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Started"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(idleTask);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(agentCommand).not.toHaveBeenCalled();
    runner.stop();
  });

  it("respects disabled config", async () => {
    const idleTask = {
      id: "task_abc123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Fix the bug",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Started"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(idleTask);

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: { defaults: { taskContinuation: { enabled: false } } },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(agentCommand).not.toHaveBeenCalled();
    runner.stop();
  });

  it("updates config dynamically", async () => {
    const idleTask = {
      id: "task_abc123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Fix the bug",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Started"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(idleTask);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    runner.updateConfig({
      agents: { defaults: { taskContinuation: { enabled: false } } },
    } as OpenClawConfig);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(agentCommand).not.toHaveBeenCalled();
    runner.stop();
  });

  it("skips tasks with pending_approval status", async () => {
    const pendingApprovalTask = {
      id: "task_pending123",
      status: "pending_approval" as const,
      priority: "high" as const,
      description: "Task awaiting approval",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Task created - awaiting approval"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(pendingApprovalTask);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(agentCommand).not.toHaveBeenCalled();
    runner.stop();
  });
});
