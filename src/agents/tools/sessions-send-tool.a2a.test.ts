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
  },
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

describe("M1 - skipPingPong in A2A flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: announce step returns some text
    mockRunAgentStep.mockResolvedValue("announce result");
    // Default: callGateway for announce delivery succeeds
    mockCallGateway.mockResolvedValue(undefined);
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
    // First call: ping-pong reply from requester
    // Second call: ping-pong reply from target (isReplySkip returns false by default)
    // After maxPingPongTurns iterations, announce step
    mockRunAgentStep
      .mockResolvedValueOnce("reply-turn-1") // ping-pong turn 1
      .mockResolvedValueOnce("reply-turn-2") // ping-pong turn 2
      .mockResolvedValueOnce("reply-turn-3") // ping-pong turn 3
      .mockResolvedValue("announce result"); // announce step

    await runSessionsSendA2AFlow(
      baseParams({ skipPingPong: false, message: "normal conversation" }),
    );

    // 3 ping-pong turns + 1 announce = 4 calls
    expect(mockRunAgentStep.mock.calls.length).toBe(4);
  });

  it("announce always runs even with skipPingPong", async () => {
    mockRunAgentStep.mockResolvedValue("announcement text");

    await runSessionsSendA2AFlow(baseParams({ skipPingPong: true }));

    // Announce step runs
    expect(mockRunAgentStep).toHaveBeenCalledTimes(1);
    // And delivery is attempted
    expect(mockCallGateway).toHaveBeenCalled();
  });

  it("emits A2A_SEND event at start", async () => {
    await runSessionsSendA2AFlow(baseParams({ skipPingPong: true }));

    const sendEvent = mockEmit.mock.calls.find((c: unknown[]) => (c[0] as any).type === "a2a.send");
    expect(sendEvent).toBeDefined();
    expect(sendEvent![0].data.fromAgent).toBe("requester");
    expect(sendEvent![0].data.toAgent).toBe("target");
    expect(sendEvent![0].data.conversationId).toBeDefined();
  });

  it("keeps full outbound message in A2A_SEND event (not clipped to 200 chars)", async () => {
    const longMessage = "M".repeat(260);
    await runSessionsSendA2AFlow(baseParams({ skipPingPong: true, message: longMessage }));

    const sendEvent = mockEmit.mock.calls.find((c: unknown[]) => (c[0] as any).type === "a2a.send");
    expect(sendEvent).toBeDefined();
    expect(sendEvent?.[0]?.data?.message).toBe(longMessage);
  });

  it("emits A2A_COMPLETE event at end", async () => {
    await runSessionsSendA2AFlow(baseParams({ skipPingPong: true }));

    const completeEvent = mockEmit.mock.calls.find(
      (c: unknown[]) => (c[0] as any).type === "a2a.complete",
    );
    expect(completeEvent).toBeDefined();
    expect(completeEvent![0].data.fromAgent).toBe("requester");
    expect(completeEvent![0].data.toAgent).toBe("target");
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

    const responseEvents = mockEmit.mock.calls.filter(
      (c: unknown[]) => (c[0] as any).type === "a2a.response",
    );
    expect(responseEvents).toHaveLength(1);
    expect(responseEvents[0]?.[0]?.data?.fromAgent).toBe("target");
    expect(responseEvents[0]?.[0]?.data?.toAgent).toBe("requester");
  });

  it("sanitizes directive tokens from initial response message", async () => {
    await runSessionsSendA2AFlow(
      baseParams({
        skipPingPong: true,
        roundOneReply: "[[reply_to_current]]\n코드 구현 상태 공유",
      }),
    );

    const responseEvent = mockEmit.mock.calls.find(
      (c: unknown[]) => (c[0] as any).type === "a2a.response",
    );
    expect(responseEvent).toBeDefined();
    expect(responseEvent?.[0]?.data?.message).toBe("코드 구현 상태 공유");
    expect(responseEvent?.[0]?.data?.replyPreview).toBe("코드 구현 상태 공유");
  });

  it("keeps full response text in message while clipping preview", async () => {
    const longReply = "L".repeat(260);
    mockRunAgentStep.mockResolvedValueOnce(longReply).mockResolvedValueOnce("announce result");

    await runSessionsSendA2AFlow(
      baseParams({
        skipPingPong: false,
        maxPingPongTurns: 1,
        message: "normal conversation",
      }),
    );

    const responseEvents = mockEmit.mock.calls
      .filter((c: unknown[]) => (c[0] as any).type === "a2a.response")
      .map((c: unknown[]) => c[0]);
    const pingPongResponse = responseEvents.find((event: any) => event.data?.turn === 1);

    expect(pingPongResponse).toBeDefined();
    expect(pingPongResponse?.data?.message).toBe(longReply);
    expect(pingPongResponse?.data?.replyPreview).toBe(longReply.slice(0, 200));
  });
});
