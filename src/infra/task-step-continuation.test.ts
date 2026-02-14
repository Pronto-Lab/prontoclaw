import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { TaskSelfDrivingHandle } from "./task-self-driving.js";

vi.mock("./agent-events.js", () => ({
  onAgentEvent: vi.fn(() => vi.fn()),
}));

vi.mock("../routing/session-key.js", () => ({
  resolveAgentIdFromSessionKey: vi.fn((key: string) => {
    const parts = key.split(":");
    return parts[1] || "main";
  }),
  isSubagentSessionKey: vi.fn(() => false),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/test-workspace"),
}));

vi.mock("../agents/tools/task-tool.js", () => ({
  findActiveTask: vi.fn(),
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn(),
}));

vi.mock("../routing/bindings.js", () => ({
  resolveAgentBoundAccountId: vi.fn(() => "test-account"),
}));

vi.mock("../process/command-queue.js", () => ({
  getQueueSize: vi.fn(() => 0),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

import { findActiveTask } from "../agents/tools/task-tool.js";
import { agentCommand } from "../commands/agent.js";
import { getQueueSize } from "../process/command-queue.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { onAgentEvent } from "./agent-events.js";
import { startTaskStepContinuation } from "./task-step-continuation.js";

type Listener = (evt: {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
}) => void;

function getListener(): Listener {
  return vi.mocked(onAgentEvent).mock.calls[0][0];
}

function fireEnd(listener: Listener, agentId = "main") {
  listener({
    runId: `run-${Date.now()}`,
    seq: 1,
    stream: "lifecycle",
    ts: Date.now(),
    data: { phase: "end" },
    sessionKey: `agent:${agentId}:main`,
  });
}

function fireStart(listener: Listener, agentId = "main") {
  listener({
    runId: `run-${Date.now()}`,
    seq: 1,
    stream: "lifecycle",
    ts: Date.now(),
    data: { phase: "start" },
    sessionKey: `agent:${agentId}:main`,
  });
}

const makeTask = (overrides: Record<string, unknown> = {}) => ({
  id: "task_abc",
  status: "in_progress",
  priority: "high",
  description: "Test task",
  created: "2026-02-05T10:00:00Z",
  lastActivity: "2026-02-05T10:00:00Z",
  progress: ["Started"],
  steps: [
    { id: "step-1", content: "Step one", status: "in_progress", order: 1 },
    { id: "step-2", content: "Step two", status: "pending", order: 2 },
  ],
  ...overrides,
});

function createMockSelfDriving(
  overrides: Partial<TaskSelfDrivingHandle> = {},
): TaskSelfDrivingHandle {
  return {
    stop: vi.fn(),
    updateConfig: vi.fn(),
    didLastAttemptSucceed: vi.fn(() => undefined),
    getLastContinuationTs: vi.fn(() => 0),
    ...overrides,
  };
}

describe("startTaskStepContinuation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T10:00:00Z"));
    vi.clearAllMocks();
    vi.mocked(findActiveTask).mockResolvedValue(null);
    vi.mocked(agentCommand).mockResolvedValue({
      text: "ok",
      sessionId: "test",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    vi.mocked(getQueueSize).mockReturnValue(0);
    vi.mocked(isSubagentSessionKey).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts and stops without error", () => {
    const handle = startTaskStepContinuation({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });
    expect(handle).toBeDefined();
    expect(handle.stop).toBeTypeOf("function");
    handle.stop();
  });

  it("triggers continuation for active task with steps (no selfDriving)", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskStepContinuation({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(2500);

    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("STEP CONTINUATION"),
        agentId: "main",
        deliver: false,
      }),
    );
    handle.stop();
  });

  it("skips when self-driving recently triggered (within grace period)", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const mockSelfDriving = createMockSelfDriving({
      getLastContinuationTs: vi.fn(() => Date.now() - 200),
    });

    const handle = startTaskStepContinuation({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
      selfDriving: mockSelfDriving,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(2500);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("triggers when self-driving grace period has expired", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const oldTs = Date.now() - 5000;
    const mockSelfDriving = createMockSelfDriving({
      getLastContinuationTs: vi.fn(() => oldTs),
      didLastAttemptSucceed: vi.fn(() => undefined),
    });

    const handle = startTaskStepContinuation({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
      selfDriving: mockSelfDriving,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(2500);

    expect(agentCommand).toHaveBeenCalled();
    handle.stop();
  });

  it("skips when self-driving last attempt succeeded recently", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const recentTs = Date.now() - 1000;
    const mockSelfDriving = createMockSelfDriving({
      getLastContinuationTs: vi.fn(() => recentTs),
      didLastAttemptSucceed: vi.fn(() => true),
    });

    const handle = startTaskStepContinuation({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
      selfDriving: mockSelfDriving,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(2500);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("triggers when self-driving is undefined", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskStepContinuation({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
      selfDriving: undefined,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(2500);

    expect(agentCommand).toHaveBeenCalled();
    handle.stop();
  });

  it("cancels timer on lifecycle start event", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskStepContinuation({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(1000);
    fireStart(listener);

    await vi.advanceTimersByTimeAsync(2000);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("skips sub-agent sessions", async () => {
    vi.mocked(isSubagentSessionKey).mockReturnValue(true);
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskStepContinuation({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(2500);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("prompt contains STEP CONTINUATION marker", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskStepContinuation({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(2500);

    const message = vi.mocked(agentCommand).mock.calls[0][0].message;
    expect(message).toContain("STEP CONTINUATION");
    expect(message).toContain("Test task");
    expect(message).toContain("complete_step");

    handle.stop();
  });

  it("does not trigger when no active task", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(null);

    const handle = startTaskStepContinuation({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(2500);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("does not trigger when task has no steps", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask({ steps: [] }));

    const handle = startTaskStepContinuation({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(2500);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("skips when agent queue is busy", async () => {
    vi.mocked(getQueueSize).mockReturnValue(3);
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskStepContinuation({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(2500);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });
});
