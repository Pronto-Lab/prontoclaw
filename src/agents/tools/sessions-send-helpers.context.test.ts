import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

import { callGateway } from "../../gateway/call.js";
import {
  buildRequesterContextSummary,
  buildAgentToAgentMessageContext,
} from "./sessions-send-helpers.js";

const mockCallGateway = vi.mocked(callGateway);

describe("buildRequesterContextSummary", () => {
  beforeEach(() => {
    mockCallGateway.mockReset();
  });

  it("returns formatted summary from session history", async () => {
    mockCallGateway.mockResolvedValueOnce({
      messages: [
        { role: "user", content: "DSN 정보 확인해줘" },
        { role: "assistant", content: [{ type: "text", text: "네, 확인하겠습니다." }] },
        { role: "user", content: "prod 환경으로 부탁해" },
      ],
    });

    const result = await buildRequesterContextSummary("agent:seum:discord:channel:123");

    expect(mockCallGateway).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:seum:discord:channel:123", limit: 10 },
    });
    expect(result).toContain("## Requester's Recent Context");
    expect(result).toContain("[user]: DSN");
    expect(result).toContain("[user]: prod");
  });

  it("returns empty string when no messages", async () => {
    mockCallGateway.mockResolvedValueOnce({ messages: [] });
    const result = await buildRequesterContextSummary("agent:x:main");
    expect(result).toBe("");
  });

  it("returns empty string on gateway error", async () => {
    mockCallGateway.mockRejectedValueOnce(new Error("timeout"));
    const result = await buildRequesterContextSummary("agent:x:main");
    expect(result).toBe("");
  });

  it("filters out toolResult messages", async () => {
    mockCallGateway.mockResolvedValueOnce({
      messages: [
        { role: "user", content: "do something" },
        { role: "toolResult", content: "tool output" },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    });

    const result = await buildRequesterContextSummary("agent:test:main");
    expect(result).not.toContain("tool output");
    expect(result).toContain("[user]: do something");
    expect(result).toContain("[assistant]: done");
  });

  it("truncates long messages to 500 chars", async () => {
    const longMsg = "x".repeat(600);
    mockCallGateway.mockResolvedValueOnce({
      messages: [{ role: "user", content: longMsg }],
    });

    const result = await buildRequesterContextSummary("agent:test:main");
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(700);
  });

  it("respects custom limit param", async () => {
    mockCallGateway.mockResolvedValueOnce({ messages: [] });
    await buildRequesterContextSummary("agent:test:main", 5);
    expect(mockCallGateway).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:test:main", limit: 5 },
    });
  });
});

describe("buildAgentToAgentMessageContext with context enrichment", () => {
  it("includes requester context summary when provided", () => {
    const result = buildAgentToAgentMessageContext({
      requesterSessionKey: "agent:seum:discord:channel:123",
      requesterChannel: "discord",
      targetSessionKey: "agent:eden:discord:channel:456",
      requesterContextSummary: "## Requester's Recent Context\n[user]: some task context",
    });

    expect(result).toContain("Agent-to-agent message context:");
    expect(result).toContain("## Requester's Recent Context");
    expect(result).toContain("[user]: some task context");
  });

  it("omits context summary when not provided", () => {
    const result = buildAgentToAgentMessageContext({
      requesterSessionKey: "agent:seum:discord:channel:123",
      targetSessionKey: "agent:eden:discord:channel:456",
    });

    expect(result).not.toContain("Requester's Recent Context");
  });

  it("omits context summary when empty string", () => {
    const result = buildAgentToAgentMessageContext({
      requesterSessionKey: "agent:seum:discord:channel:123",
      targetSessionKey: "agent:eden:discord:channel:456",
      requesterContextSummary: "   ",
    });

    expect(result).not.toContain("Requester's Recent Context");
  });
});
