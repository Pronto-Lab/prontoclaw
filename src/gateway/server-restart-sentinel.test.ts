import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/tools/sessions-send-helpers.js", () => ({
  resolveAnnounceTargetFromKey: vi.fn().mockReturnValue(null),
}));

vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: vi.fn((id) => id),
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: vi.fn().mockReturnValue("main:session"),
}));

vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: vi.fn().mockReturnValue({ ok: true, to: "+1234567890" }),
}));

vi.mock("../infra/restart-sentinel.js", () => ({
  consumeRestartSentinel: vi.fn().mockResolvedValue(null),
  formatRestartSentinelMessage: vi.fn().mockReturnValue("Gateway restarted"),
  summarizeRestartSentinel: vi.fn().mockReturnValue("Restart summary"),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../routing/session-key.js", () => ({
  buildAgentMainSessionKey: vi.fn(({ agentId }) => `agent:${agentId}:main`),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {},
}));

vi.mock("../utils/delivery-context.js", () => ({
  deliveryContextFromSession: vi.fn().mockReturnValue(null),
  mergeDeliveryContext: vi.fn((a, b) => a || b),
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: vi.fn().mockReturnValue({ cfg: {}, entry: null }),
}));

import { agentCommand } from "../commands/agent.js";
import { consumeRestartSentinel } from "../infra/restart-sentinel.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";

describe("server-restart-sentinel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("scheduleRestartSentinelWake", () => {
    it("returns early when no sentinel exists", async () => {
      vi.mocked(consumeRestartSentinel).mockResolvedValue(null);

      await scheduleRestartSentinelWake({ deps: {} as never });

      expect(agentCommand).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    });

    it("calls notifyRequestingAgent when requestingAgentId is present", async () => {
      vi.mocked(consumeRestartSentinel).mockResolvedValue({
        payload: {
          reason: "restart requested",
          requestingAgentId: "main",
          deliveryContext: { channel: "discord", to: "user123" },
        },
      } as never);

      await scheduleRestartSentinelWake({ deps: {} as never });

      expect(agentCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          sessionKey: "agent:main:main",
          deliver: false,
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it("falls back to enqueueSystemEvent when no sessionKey", async () => {
      vi.mocked(consumeRestartSentinel).mockResolvedValue({
        payload: {
          reason: "restart",
          sessionKey: "",
        },
      } as never);

      await scheduleRestartSentinelWake({ deps: {} as never });

      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "Gateway restarted",
        expect.objectContaining({ sessionKey: "main:session" }),
      );
    });

    it("handles sessionKey with :topic: marker", async () => {
      vi.mocked(consumeRestartSentinel).mockResolvedValue({
        payload: {
          reason: "restart",
          sessionKey: "telegram:chat123:topic:456",
          deliveryContext: { channel: "telegram", to: "chat123" },
        },
      } as never);

      await scheduleRestartSentinelWake({ deps: {} as never });

      expect(agentCommand).toHaveBeenCalled();
    });

    it("handles sessionKey with :thread: marker", async () => {
      vi.mocked(consumeRestartSentinel).mockResolvedValue({
        payload: {
          reason: "restart",
          sessionKey: "discord:channel789:thread:111",
          deliveryContext: { channel: "discord", to: "channel789" },
        },
      } as never);

      await scheduleRestartSentinelWake({ deps: {} as never });

      expect(agentCommand).toHaveBeenCalled();
    });
  });

  describe("shouldWakeFromRestartSentinel", () => {
    it("returns false in VITEST environment", () => {
      const result = shouldWakeFromRestartSentinel();

      expect(result).toBe(false);
    });
  });
});
