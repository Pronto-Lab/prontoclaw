import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCallGateway = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mockCallGateway(...args),
}));

const mockEmit = vi.fn();
vi.mock("../../infra/events/bus.js", () => ({
  emit: (...args: unknown[]) => mockEmit(...args),
}));

vi.mock("../../infra/events/schemas.js", () => ({
  EVENT_TYPES: {
    A2A_SEND: "a2a.send",
    A2A_RESPONSE: "a2a.response",
    A2A_COMPLETE: "a2a.complete",
    A2A_RETRY: "a2a.retry",
  },
}));

const { MockA2AConcurrencyError, mockAcquire, mockRelease, mockGetA2AConcurrencyGate } = vi.hoisted(
  () => {
    class HoistedA2AConcurrencyError extends Error {
      constructor(
        public readonly agentId: string,
        public readonly flowId: string,
        public readonly activeCount: number,
        public readonly queueTimeoutMs: number,
      ) {
        super("A2A concurrency limit exceeded");
        this.name = "A2AConcurrencyError";
      }
    }

    return {
      MockA2AConcurrencyError: HoistedA2AConcurrencyError,
      mockAcquire: vi.fn(),
      mockRelease: vi.fn(),
      mockGetA2AConcurrencyGate: vi.fn(),
    };
  },
);

vi.mock("../a2a-concurrency.js", () => ({
  A2AConcurrencyError: MockA2AConcurrencyError,
  getA2AConcurrencyGate: (...args: unknown[]) => mockGetA2AConcurrencyGate(...args),
}));

const mockRunAgentStep = vi.fn();
const mockReadLatestAssistantReply = vi.fn();
vi.mock("./agent-step.js", () => ({
  runAgentStep: (...args: unknown[]) => mockRunAgentStep(...args),
  readLatestAssistantReply: (...args: unknown[]) => mockReadLatestAssistantReply(...args),
}));

vi.mock("./sessions-announce-target.js", () => ({
  resolveAnnounceTarget: vi.fn().mockResolvedValue({
    to: "channel-123",
    channel: "discord",
    accountId: "acc-1",
  }),
}));

vi.mock("./sessions-send-helpers.js", () => ({
  buildAgentToAgentAnnounceContext: vi.fn().mockReturnValue("announce-prompt"),
  buildAgentToAgentReplyContext: vi.fn().mockReturnValue("reply-prompt"),
  isAnnounceSkip: vi.fn().mockReturnValue(false),
  isReplySkip: vi.fn().mockReturnValue(false),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("../../infra/errors.js", () => ({
  formatErrorMessage: vi.fn((e: unknown) => String(e)),
}));

vi.mock("../lanes.js", () => ({
  AGENT_LANE_NESTED: "nested",
}));

import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    targetSessionKey: "agent:target:main",
    displayKey: "target",
    message: "test message",
    announceTimeoutMs: 10000,
    maxPingPongTurns: 3,
    requesterSessionKey: "agent:requester:main",
    roundOneReply: "initial reply",
    ...overrides,
  };
}

type EmittedEvent = {
  type?: string;
  data?: Record<string, unknown>;
};

function eventFromCall(call: unknown[]): EmittedEvent {
  const first = call[0];
  if (!first || typeof first !== "object") {
    return {};
  }
  return first as EmittedEvent;
}

describe("M1 - skipPingPong in A2A flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetA2AConcurrencyGate.mockReturnValue(null);
    // Default: announce step returns some text
    mockRunAgentStep.mockResolvedValue({ reply: "announce result", ok: true });
    // Default: callGateway for announce delivery succeeds
    mockCallGateway.mockResolvedValue(undefined);
  });

  it("handles concurrency gate timeout as blocked outcome without throwing", async () => {
    mockGetA2AConcurrencyGate.mockReturnValue({
      acquire: (...args: unknown[]) => mockAcquire(...args),
      release: (...args: unknown[]) => mockRelease(...args),
    });
    mockAcquire.mockRejectedValue(new MockA2AConcurrencyError("target", "flow-1", 3, 30_000));
    mockRelease.mockReturnValue(undefined);

    await expect(
      runSessionsSendA2AFlow(baseParams({ skipPingPong: true })),
    ).resolves.toBeUndefined();

    expect(mockRunAgentStep).not.toHaveBeenCalled();

    const responseEvent = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .find((event) => event.type === "a2a.response");
    expect(responseEvent).toBeDefined();
    expect(responseEvent?.data?.outcome).toBe("blocked");

    const completeEvent = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .find((event) => event.type === "a2a.complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.data?.concurrencyBlocked).toBe(true);
  });

  it("explicit skipPingPong=true skips ping-pong loop", async () => {
    await runSessionsSendA2AFlow(baseParams({ skipPingPong: true }));

    // runAgentStep should be called ONCE (announce only), not for ping-pong
    expect(mockRunAgentStep).toHaveBeenCalledTimes(1);
    // The single call should be for announce (message = "Agent-to-agent announce step.")
    expect(mockRunAgentStep.mock.calls[0][0].message).toBe("Agent-to-agent announce step.");
  });

  it("auto-detect [NO_REPLY_NEEDED] skips ping-pong", async () => {
    await runSessionsSendA2AFlow(
      baseParams({ message: "Update: [NO_REPLY_NEEDED] task done", skipPingPong: false }),
    );

    // Only announce step
    expect(mockRunAgentStep).toHaveBeenCalledTimes(1);
    expect(mockRunAgentStep.mock.calls[0][0].message).toBe("Agent-to-agent announce step.");
  });

  it("auto-detect [NOTIFICATION] skips ping-pong", async () => {
    await runSessionsSendA2AFlow(baseParams({ message: "[NOTIFICATION] FYI update" }));

    expect(mockRunAgentStep).toHaveBeenCalledTimes(1);
  });

  it("normal flow runs ping-pong when no skip signal", async () => {
    // Use a collaboration-intent message to trigger full ping-pong turns
    // "같이 검토" triggers collaboration intent → suggestedTurns = -1 → uses config max (3)
    mockRunAgentStep
      .mockResolvedValueOnce({
        reply: "reply-turn-1: let me check the implementation details carefully",
        ok: true,
      }) // ping-pong turn 1
      .mockResolvedValueOnce({
        reply: "reply-turn-2: here are the issues I found in the code review",
        ok: true,
      }) // ping-pong turn 2
      .mockResolvedValueOnce({
        reply: "reply-turn-3: final review comments and suggestions below",
        ok: true,
      }) // ping-pong turn 3
      .mockResolvedValue({ reply: "announce result", ok: true }); // announce step

    await runSessionsSendA2AFlow(
      baseParams({ skipPingPong: false, message: "같이 이 코드 검토해줄래? 피드백 부탁해" }),
    );

    // 3 ping-pong turns + 1 announce = 4 calls
    expect(mockRunAgentStep.mock.calls.length).toBe(4);
  });

  it("uses per-turn timeout for ping-pong and keeps announce timeout", async () => {
    mockRunAgentStep
      .mockResolvedValueOnce({ reply: "reply-turn-1", ok: true })
      .mockResolvedValueOnce({ reply: "announce result", ok: true });

    await runSessionsSendA2AFlow(
      baseParams({
        skipPingPong: false,
        maxPingPongTurns: 1,
        message: "normal conversation",
        announceTimeoutMs: 43210,
        requesterSessionKey: "ext:requester",
      }),
    );

    const pingPongCall = mockRunAgentStep.mock.calls[0]?.[0];
    const announceCall = mockRunAgentStep.mock.calls[1]?.[0];

    expect(pingPongCall.timeoutMs).toBe(120_000);
    expect(announceCall.message).toBe("Agent-to-agent announce step.");
    expect(announceCall.timeoutMs).toBe(43_210);
  });

  it("announce always runs even with skipPingPong", async () => {
    mockRunAgentStep.mockResolvedValue({ reply: "announcement text", ok: true });

    await runSessionsSendA2AFlow(baseParams({ skipPingPong: true }));

    // Announce step runs
    expect(mockRunAgentStep).toHaveBeenCalledTimes(1);
    // And delivery is attempted
    expect(mockCallGateway).toHaveBeenCalled();
  });

  it("emits A2A_SEND event at start", async () => {
    await runSessionsSendA2AFlow(baseParams({ skipPingPong: true }));

    const sendEvent = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .find((event) => event.type === "a2a.send");
    expect(sendEvent).toBeDefined();
    expect(sendEvent?.data?.fromAgent).toBe("requester");
    expect(sendEvent?.data?.toAgent).toBe("target");
    expect(sendEvent?.data?.conversationId).toBeDefined();
  });

  it("keeps full outbound message in A2A_SEND event (not clipped to 200 chars)", async () => {
    const longMessage = "M".repeat(260);
    await runSessionsSendA2AFlow(baseParams({ skipPingPong: true, message: longMessage }));

    const sendEvent = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .find((event) => event.type === "a2a.send");
    expect(sendEvent).toBeDefined();
    expect(sendEvent?.data?.message).toBe(longMessage);
  });

  it("emits A2A_COMPLETE event at end", async () => {
    await runSessionsSendA2AFlow(baseParams({ skipPingPong: true }));

    const completeEvent = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .find((event) => event.type === "a2a.complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.data?.fromAgent).toBe("requester");
    expect(completeEvent?.data?.toAgent).toBe("target");
  });

  it("[NO_REPLY_NEEDED] in message overrides even when skipPingPong not set", async () => {
    // skipPingPong is undefined (not explicitly false), message has tag
    await runSessionsSendA2AFlow(
      baseParams({ message: "done [NO_REPLY_NEEDED]", skipPingPong: undefined }),
    );

    // Should skip ping-pong: only announce
    expect(mockRunAgentStep).toHaveBeenCalledTimes(1);
  });

  it("emits initial A2A_RESPONSE even when ping-pong is skipped", async () => {
    await runSessionsSendA2AFlow(baseParams({ skipPingPong: true }));

    const responseEvents = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .filter((event) => event.type === "a2a.response");
    expect(responseEvents).toHaveLength(1);
    expect(responseEvents[0]?.data?.fromAgent).toBe("target");
    expect(responseEvents[0]?.data?.toAgent).toBe("requester");
  });

  it("sanitizes directive tokens from initial response message", async () => {
    await runSessionsSendA2AFlow(
      baseParams({
        skipPingPong: true,
        roundOneReply: "[[reply_to_current]]\n코드 구현 상태 공유",
      }),
    );

    const responseEvent = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .find((event) => event.type === "a2a.response");
    expect(responseEvent).toBeDefined();
    expect(responseEvent?.data?.message).toBe("코드 구현 상태 공유");
    expect(responseEvent?.data?.replyPreview).toBe("코드 구현 상태 공유");
  });

  it("keeps full response text in message while clipping preview", async () => {
    const longReply = "L".repeat(260);
    mockRunAgentStep
      .mockResolvedValueOnce({ reply: longReply, ok: true })
      .mockResolvedValueOnce({ reply: "announce result", ok: true });

    await runSessionsSendA2AFlow(
      baseParams({
        skipPingPong: false,
        maxPingPongTurns: 1,
        message: "normal conversation",
      }),
    );

    const responseEvents = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .filter((event) => event.type === "a2a.response");
    const pingPongResponse = responseEvents.find((event) => event.data?.turn === 1);

    expect(pingPongResponse).toBeDefined();
    expect(pingPongResponse?.data?.message).toBe(longReply);
    expect(pingPongResponse?.data?.replyPreview).toBe(longReply.slice(0, 200));
  });

  it("emits outcome A2A_RESPONSE when waitRunId path times out without reply", async () => {
    mockCallGateway.mockResolvedValue({ status: "timeout" });
    mockReadLatestAssistantReply.mockResolvedValue(undefined);

    await runSessionsSendA2AFlow(
      baseParams({
        roundOneReply: undefined,
        waitRunId: "run-timeout-1",
        skipPingPong: true,
      }),
    );

    const responseEvents = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .filter((event) => event.type === "a2a.response");
    expect(responseEvents).toHaveLength(1);
    const timeoutMessage = responseEvents[0]?.data?.message;
    expect(typeof timeoutMessage).toBe("string");
    expect(timeoutMessage).toContain("메시지가 전달되었으나 응답을 수신하지 못했습니다");
    expect(responseEvents[0]?.data?.outcome).toBe("no_reply");

    const completeEvent = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .find((event) => event.type === "a2a.complete");
    expect(completeEvent).toBeDefined();

    const retryEvents = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .filter((event) => event.type === "a2a.retry");
    expect(retryEvents).toHaveLength(0);
  });

  it("emits outcome A2A_RESPONSE when waitRunId returns error status", async () => {
    mockCallGateway.mockResolvedValue({ status: "error", error: "rate limit" });
    mockReadLatestAssistantReply.mockResolvedValue(undefined);

    await runSessionsSendA2AFlow(
      baseParams({
        roundOneReply: undefined,
        waitRunId: "run-error-1",
        skipPingPong: true,
      }),
    );

    const responseEvents = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .filter((event) => event.type === "a2a.response");
    expect(responseEvents).toHaveLength(1);
    const errorMessage = responseEvents[0]?.data?.message;
    expect(typeof errorMessage).toBe("string");
    expect(errorMessage).toContain("rate limit");
    expect(responseEvents[0]?.data?.outcome).toBe("no_reply");
  });

  it("ping-pong terminates with turn_timeout when runAgentStep times out", async () => {
    mockRunAgentStep.mockReset();
    mockRunAgentStep.mockResolvedValue({
      reply: undefined,
      ok: false,
      error: { code: "timeout", message: "agent step timed out" },
    });

    await runSessionsSendA2AFlow(
      baseParams({
        skipPingPong: false,
        maxPingPongTurns: 3,
        message: "같이 이 코드 검토해줄래?",
      }),
    );

    const completeEvent = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .find((event) => event.type === "a2a.complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.data?.terminationReason).toBe("turn_timeout");
    expect(completeEvent?.data?.actualTurns).toBe(0);
  });

  it("ping-pong terminates with agent_error when runAgentStep fails non-timeout", async () => {
    mockRunAgentStep.mockReset();
    mockRunAgentStep.mockResolvedValue({
      reply: undefined,
      ok: false,
      error: { code: "gateway_error", message: "connection refused" },
    });

    await runSessionsSendA2AFlow(
      baseParams({
        skipPingPong: false,
        maxPingPongTurns: 3,
        message: "같이 이 코드 검토해줄래?",
      }),
    );

    const completeEvent = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .find((event) => event.type === "a2a.complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.data?.terminationReason).toBe("agent_error");
    expect(completeEvent?.data?.actualTurns).toBe(0);
  });

  it("ping-pong terminates with empty_reply when runAgentStep succeeds without text", async () => {
    mockRunAgentStep.mockReset();
    mockRunAgentStep.mockResolvedValue({ reply: undefined, ok: true });

    await runSessionsSendA2AFlow(
      baseParams({
        skipPingPong: false,
        maxPingPongTurns: 3,
        message: "같이 이 코드 검토해줄래?",
      }),
    );

    const completeEvent = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .find((event) => event.type === "a2a.complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.data?.terminationReason).toBe("empty_reply");
    expect(completeEvent?.data?.actualTurns).toBe(0);
  });

  it("ping-pong terminates with explicit_skip only when REPLY_SKIP token present", async () => {
    const { isReplySkip } = await import("./sessions-send-helpers.js");

    mockRunAgentStep.mockReset();
    mockRunAgentStep.mockResolvedValue({ reply: "REPLY_SKIP", ok: true });
    vi.mocked(isReplySkip).mockReturnValue(true);

    await runSessionsSendA2AFlow(
      baseParams({
        skipPingPong: false,
        maxPingPongTurns: 3,
        message: "같이 이 코드 검토해줄래?",
      }),
    );

    const completeEvent = mockEmit.mock.calls
      .map((c: unknown[]) => eventFromCall(c))
      .find((event) => event.type === "a2a.complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.data?.terminationReason).toBe("explicit_skip");
  });
});
