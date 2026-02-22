import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

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
import { startTaskSelfDriving } from "./task-self-driving.js";

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

describe("startTaskSelfDriving", () => {
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
    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });
    expect(handle).toBeDefined();
    expect(handle.stop).toBeTypeOf("function");
    expect(handle.didLastAttemptSucceed).toBeTypeOf("function");
    expect(handle.getLastContinuationTs).toBeTypeOf("function");
    handle.stop();
  });

  it("does not trigger when no active task", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(null);

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(600);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("triggers continuation for active task with steps", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(600);

    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("SELF-DRIVING LOOP"),
        agentId: "main",
        deliver: false,
      }),
    );
    handle.stop();
  });

  it("does not trigger for simple task without steps", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask({ steps: [], simple: true }));
    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });
    const listener = getListener();
    fireEnd(listener);
    await vi.advanceTimersByTimeAsync(600);
    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("does not trigger for completed task", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask({ status: "completed" }));

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(600);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("cancels timer when lifecycle start fires", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    // Before the 500ms delay, fire a start event
    await vi.advanceTimersByTimeAsync(200);
    fireStart(listener);

    await vi.advanceTimersByTimeAsync(500);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("skips sub-agent sessions", async () => {
    vi.mocked(isSubagentSessionKey).mockReturnValue(true);
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(600);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("skips when agent queue is busy", async () => {
    vi.mocked(getQueueSize).mockReturnValue(2);
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(600);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("tracks same-step stalls and escalates after 3 attempts", async () => {
    // Task where step-1 is always in_progress (never completes)
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();

    // Trigger 3 times — each time step-1 is still in_progress
    for (let i = 0; i < 3; i++) {
      fireEnd(listener);
      await vi.advanceTimersByTimeAsync(600);
    }

    expect(agentCommand).toHaveBeenCalledTimes(3);

    // 3rd call should be escalation prompt
    const thirdCall = vi.mocked(agentCommand).mock.calls[2];
    expect(thirdCall[0].message).toContain("SELF-DRIVING ESCALATION");
    expect(thirdCall[0].message).toContain("Choose ONE");

    handle.stop();
  });

  it("re-escalates at intervals after first escalation", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());
    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();

    // Trigger 9 times on same step
    for (let i = 0; i < 9; i++) {
      fireEnd(listener);
      await vi.advanceTimersByTimeAsync(600);
    }

    expect(agentCommand).toHaveBeenCalledTimes(9);

    // call[2] (sameStepCount=3) = first escalation
    expect(vi.mocked(agentCommand).mock.calls[2][0].message).toContain("ESCALATION");
    // calls 3-6 (sameStepCount=4,5,6,7) = normal self-driving
    expect(vi.mocked(agentCommand).mock.calls[3][0].message).toContain("SELF-DRIVING LOOP");
    expect(vi.mocked(agentCommand).mock.calls[6][0].message).toContain("SELF-DRIVING LOOP");

    // call[7] (sameStepCount=8) = re-escalation ((8-3) % 5 === 0)
    expect(vi.mocked(agentCommand).mock.calls[7][0].message).toContain("ESCALATION");
    handle.stop();
  });

  it("resets stall tracking when step changes", async () => {
    const taskStepA = makeTask();

    vi.mocked(findActiveTask).mockResolvedValue(taskStepA);

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();

    // 2 stalls on step-1
    fireEnd(listener);
    await vi.advanceTimersByTimeAsync(600);
    fireEnd(listener);
    await vi.advanceTimersByTimeAsync(600);

    // Now step-1 completes and step-2 starts
    const taskStepB = makeTask({
      steps: [
        { id: "step-1", content: "Step one", status: "done", order: 1 },
        { id: "step-2", content: "Step two", status: "in_progress", order: 2 },
      ],
    });
    vi.mocked(findActiveTask).mockResolvedValue(taskStepB);

    // Fire again — should reset stall counter (sameStepCount = 1 for step-2)
    fireEnd(listener);
    await vi.advanceTimersByTimeAsync(600);

    // This should NOT be an escalation prompt (only 1 stall on step-2)
    const lastCall = vi.mocked(agentCommand).mock.calls[2];
    expect(lastCall[0].message).toContain("SELF-DRIVING LOOP");
    expect(lastCall[0].message).not.toContain("ESCALATION");

    handle.stop();
  });

  it("respects MAX_CONSECUTIVE_CONTINUATIONS (50)", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());
    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();

    // Fire 52 end events
    for (let i = 0; i < 52; i++) {
      fireEnd(listener);
      await vi.advanceTimersByTimeAsync(600);
    }

    // Should cap at 50
    expect(vi.mocked(agentCommand).mock.calls.length).toBeLessThanOrEqual(50);
    handle.stop();
  });

  it("resets consecutive count after COOLDOWN_RESET_MS (60s)", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();

    // Fire 5 times
    for (let i = 0; i < 5; i++) {
      fireEnd(listener);
      await vi.advanceTimersByTimeAsync(600);
    }

    expect(agentCommand).toHaveBeenCalledTimes(5);

    // Advance time past cooldown (60 seconds)
    await vi.advanceTimersByTimeAsync(61_000);

    vi.mocked(agentCommand).mockClear();

    // Fire again — counter should have reset
    fireEnd(listener);
    await vi.advanceTimersByTimeAsync(600);

    expect(agentCommand).toHaveBeenCalledTimes(1);

    // The prompt should show count 1 (reset)
    expect(vi.mocked(agentCommand).mock.calls[0][0].message).toContain("SELF-DRIVING LOOP 1/");

    handle.stop();
  });

  it("getLastContinuationTs returns correct timestamp", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    // Before any trigger
    expect(handle.getLastContinuationTs("main")).toBe(0);

    const listener = getListener();
    fireEnd(listener);
    await vi.advanceTimersByTimeAsync(600);

    // After trigger
    expect(handle.getLastContinuationTs("main")).toBeGreaterThan(0);

    handle.stop();
  });

  it("didLastAttemptSucceed returns correct state", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    // Before any trigger
    expect(handle.didLastAttemptSucceed("main")).toBeUndefined();

    const listener = getListener();

    // Successful attempt
    fireEnd(listener);
    await vi.advanceTimersByTimeAsync(600);
    expect(handle.didLastAttemptSucceed("main")).toBe(true);

    // Failed attempt
    vi.mocked(agentCommand).mockRejectedValueOnce(new Error("fail"));
    fireEnd(listener);
    await vi.advanceTimersByTimeAsync(600);
    expect(handle.didLastAttemptSucceed("main")).toBe(false);

    handle.stop();
  });

  it("ignores non-lifecycle events", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();

    // Fire a tool event (not lifecycle)
    listener({
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "end" },
      sessionKey: "agent:main:main",
    });

    await vi.advanceTimersByTimeAsync(600);

    expect(agentCommand).not.toHaveBeenCalled();
    handle.stop();
  });

  it("prompt includes task description and step markers", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask());

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);
    await vi.advanceTimersByTimeAsync(600);

    const message = vi.mocked(agentCommand).mock.calls[0][0].message;
    expect(message).toContain("Test task");
    expect(message).toContain("step-1");
    expect(message).toContain("step-2");
    expect(message).toContain("Continue:");
    expect(message).toContain("complete_step");

    handle.stop();
  });

  describe("zero-progress escalation", () => {
    it("escalates after 5 runs with zero step progress", async () => {
      let callCount = 0;
      vi.mocked(findActiveTask).mockImplementation(async () => {
        callCount++;
        return makeTask({
          steps: [
            {
              id: `step-${callCount}`,
              content: `Step ${callCount}`,
              status: "in_progress",
              order: 1,
            },
            { id: "step-final", content: "Final step", status: "pending", order: 2 },
          ],
        });
      });

      const handle = startTaskSelfDriving({
        cfg: { agents: { defaults: {} } } as OpenClawConfig,
      });

      const listener = getListener();

      for (let i = 0; i < 5; i++) {
        fireEnd(listener);
        await vi.advanceTimersByTimeAsync(600);
      }

      expect(agentCommand).toHaveBeenCalledTimes(5);

      const fifthCall = vi.mocked(agentCommand).mock.calls[4];
      expect(fifthCall[0].message).toContain("ESCALATION");
      expect(fifthCall[0].message).toContain("ZERO step progress");

      handle.stop();
    });
  });

  it("sends steps-missing prompt for non-simple task without steps", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask({ steps: [], simple: undefined }));

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();
    fireEnd(listener);

    await vi.advanceTimersByTimeAsync(600);

    expect(agentCommand).toHaveBeenCalledTimes(1);
    const message = vi.mocked(agentCommand).mock.calls[0][0].message;
    expect(message).toContain("STEPS REQUIRED");
    expect(message).toContain("task_update");
    expect(message).toContain("set_steps");

    handle.stop();
  });

  it("stops steps-missing prompts after 3 attempts", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(makeTask({ steps: [], simple: undefined }));

    const handle = startTaskSelfDriving({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    const listener = getListener();

    for (let i = 0; i < 5; i++) {
      fireEnd(listener);
      await vi.advanceTimersByTimeAsync(600);
    }

    expect(agentCommand).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      expect(vi.mocked(agentCommand).mock.calls[i][0].message).toContain("STEPS REQUIRED");
    }

    handle.stop();
  });
});
