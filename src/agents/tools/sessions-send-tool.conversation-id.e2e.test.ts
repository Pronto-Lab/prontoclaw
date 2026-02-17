import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

const runSessionsSendA2AFlowMock = vi.fn();
vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: (opts: unknown) => runSessionsSendA2AFlowMock(opts),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () =>
      ({
        session: {
          scope: "per-sender",
          mainKey: "main",
          agentToAgent: { maxPingPongTurns: 2 },
        },
        tools: {
          agentToAgent: {
            enabled: true,
            allow: ["*"],
          },
        },
      }) as never,
  };
});

import { createSessionsSendTool } from "./sessions-send-tool.js";

describe("sessions_send conversationId continuity", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    runSessionsSendA2AFlowMock.mockReset();
    runSessionsSendA2AFlowMock.mockResolvedValue(undefined);
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string; params?: Record<string, unknown> };
      if (req.method === "sessions.resolve") {
        const key = (typeof req.params?.key === "string" && req.params.key) || "agent:eden:main";
        return { key };
      }
      if (req.method === "agent") {
        return { runId: "run-send-1" };
      }
      return {};
    });
  });

  it("passes explicit conversationId to a2a flow and tool result", async () => {
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:ruda:main",
      agentChannel: "discord",
    });

    const result = await tool.execute("call-explicit-conv", {
      sessionKey: "agent:eden:main",
      message: "hello",
      timeoutSeconds: 0,
      workSessionId: "ws-explicit",
      conversationId: "conv-explicit-1",
    });

    const flowParams = runSessionsSendA2AFlowMock.mock.calls[0]?.[0] as
      | { conversationId?: string }
      | undefined;
    expect(flowParams?.conversationId).toBe("conv-explicit-1");
    expect(result.details).toMatchObject({
      status: "accepted",
      conversationId: "conv-explicit-1",
    });
  });

  it("reuses conversationId for same workSession+agent pair when omitted", async () => {
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:ruda:main",
      agentChannel: "discord",
    });

    const first = await tool.execute("call-auto-conv-1", {
      sessionKey: "agent:eden:main",
      message: "first",
      timeoutSeconds: 0,
      workSessionId: "ws-shared",
    });
    const second = await tool.execute("call-auto-conv-2", {
      sessionKey: "agent:eden:main",
      message: "second",
      timeoutSeconds: 0,
      workSessionId: "ws-shared",
    });

    const firstFlowParams = runSessionsSendA2AFlowMock.mock.calls[0]?.[0] as
      | { conversationId?: string }
      | undefined;
    const secondFlowParams = runSessionsSendA2AFlowMock.mock.calls[1]?.[0] as
      | { conversationId?: string }
      | undefined;

    expect(typeof firstFlowParams?.conversationId).toBe("string");
    expect(firstFlowParams?.conversationId).toBeTruthy();
    expect(secondFlowParams?.conversationId).toBe(firstFlowParams?.conversationId);
    expect((first.details as { conversationId?: string }).conversationId).toBe(
      firstFlowParams?.conversationId,
    );
    expect((second.details as { conversationId?: string }).conversationId).toBe(
      firstFlowParams?.conversationId,
    );
  });
});
