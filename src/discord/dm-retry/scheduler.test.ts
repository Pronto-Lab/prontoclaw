import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before imports
vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../send.outbound.js", () => ({
  sendMessageDiscord: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./tracker.js", () => ({
  cleanupOldEntries: vi.fn().mockResolvedValue(0),
  getTimedOutDms: vi.fn().mockReturnValue([]),
  incrementRetryAttempt: vi.fn().mockResolvedValue(null),
  markDmFailed: vi.fn().mockResolvedValue(null),
}));

vi.mock("./utils.js", () => ({
  resolveDmRetryConfig: vi.fn().mockReturnValue({
    enabled: false,
    timeoutMs: 300000,
    maxAttempts: 3,
    backoffMs: 60000,
    notifyOnFailure: true,
  }),
  truncateText: vi.fn((text: string) => text.slice(0, 100)),
}));

import type { OpenClawConfig } from "../../config/config.js";
import type { TrackedDm } from "./tracker.js";
import { logVerbose } from "../../globals.js";
import { sendMessageDiscord } from "../send.outbound.js";
import { startDmRetryScheduler, stopDmRetryScheduler, updateSchedulerConfig } from "./scheduler.js";
import { getTimedOutDms, incrementRetryAttempt, markDmFailed } from "./tracker.js";
import { resolveDmRetryConfig } from "./utils.js";

describe("dm-retry scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    stopDmRetryScheduler(); // Ensure clean state
  });

  afterEach(() => {
    stopDmRetryScheduler();
    vi.useRealTimers();
  });

  describe("startDmRetryScheduler", () => {
    it("does nothing when disabled", () => {
      vi.mocked(resolveDmRetryConfig).mockReturnValue({
        enabled: false,
        timeoutMs: 300000,
        maxAttempts: 3,
        backoffMs: 60000,
        notifyOnFailure: true,
      });

      const cfg = {} as OpenClawConfig;
      startDmRetryScheduler(cfg);

      expect(logVerbose).toHaveBeenCalledWith("dm-retry: scheduler disabled");
    });

    it("starts scheduler when enabled", () => {
      vi.mocked(resolveDmRetryConfig).mockReturnValue({
        enabled: true,
        timeoutMs: 300000,
        maxAttempts: 3,
        backoffMs: 60000,
        notifyOnFailure: true,
      });

      const cfg = {} as OpenClawConfig;
      startDmRetryScheduler(cfg);

      expect(logVerbose).toHaveBeenCalledWith("dm-retry: scheduler started");
    });

    it("processes pending retries on interval", async () => {
      vi.mocked(resolveDmRetryConfig).mockReturnValue({
        enabled: true,
        timeoutMs: 300000,
        maxAttempts: 3,
        backoffMs: 60000,
        notifyOnFailure: true,
      });

      const timedOutDm: TrackedDm = {
        id: "dm-1",
        messageId: "msg-1",
        channelId: "ch-1",
        senderAgentId: "main",
        targetUserId: "user-1",
        originalText: "Hello",
        sentAt: 1000,
        attempts: 1,
        lastAttemptAt: 1000,
        status: "pending",
      };
      vi.mocked(getTimedOutDms).mockReturnValue([timedOutDm]);
      vi.mocked(incrementRetryAttempt).mockResolvedValue({ ...timedOutDm, attempts: 2 });

      const cfg = {} as OpenClawConfig;
      startDmRetryScheduler(cfg);

      // Advance past the check interval (60s)
      await vi.advanceTimersByTimeAsync(60_000);

      expect(getTimedOutDms).toHaveBeenCalled();
      expect(incrementRetryAttempt).toHaveBeenCalledWith("dm-1");
      expect(sendMessageDiscord).toHaveBeenCalledWith("channel:ch-1", "[Retry 2] Hello");
    });

    it("marks DM as failed after max attempts", async () => {
      vi.mocked(resolveDmRetryConfig).mockReturnValue({
        enabled: true,
        timeoutMs: 300000,
        maxAttempts: 3,
        backoffMs: 60000,
        notifyOnFailure: true,
      });

      const timedOutDm: TrackedDm = {
        id: "dm-1",
        messageId: "msg-1",
        channelId: "ch-1",
        senderAgentId: "main",
        targetUserId: "user-1",
        originalText: "Hello",
        sentAt: 1000,
        attempts: 3, // At max
        lastAttemptAt: 1000,
        status: "pending",
      };
      vi.mocked(getTimedOutDms).mockReturnValue([timedOutDm]);

      const cfg = {} as OpenClawConfig;
      startDmRetryScheduler(cfg);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(markDmFailed).toHaveBeenCalledWith("dm-1");
      expect(incrementRetryAttempt).not.toHaveBeenCalled();
    });

    it("sends failure notification when notifyOnFailure is enabled", async () => {
      vi.mocked(resolveDmRetryConfig).mockReturnValue({
        enabled: true,
        timeoutMs: 300000,
        maxAttempts: 3,
        backoffMs: 60000,
        notifyOnFailure: true,
      });

      const timedOutDm: TrackedDm = {
        id: "dm-1",
        messageId: "msg-1",
        channelId: "ch-1",
        senderAgentId: "main",
        targetUserId: "user-1",
        originalText: "Hello World",
        sentAt: 1000,
        attempts: 3,
        lastAttemptAt: 1000,
        status: "pending",
      };
      vi.mocked(getTimedOutDms).mockReturnValue([timedOutDm]);

      const cfg = {} as OpenClawConfig;
      startDmRetryScheduler(cfg);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(markDmFailed).toHaveBeenCalledWith("dm-1");
      expect(sendMessageDiscord).toHaveBeenCalledWith(
        "channel:ch-1",
        expect.stringContaining("DM 전송 실패"),
      );
      expect(sendMessageDiscord).toHaveBeenCalledWith(
        "channel:ch-1",
        expect.stringContaining("user-1"),
      );
    });

    it("does not send notification when notifyOnFailure is disabled", async () => {
      vi.mocked(resolveDmRetryConfig).mockReturnValue({
        enabled: true,
        timeoutMs: 300000,
        maxAttempts: 3,
        backoffMs: 60000,
        notifyOnFailure: false,
      });

      const timedOutDm: TrackedDm = {
        id: "dm-1",
        messageId: "msg-1",
        channelId: "ch-1",
        senderAgentId: "main",
        targetUserId: "user-1",
        originalText: "Hello",
        sentAt: 1000,
        attempts: 3,
        lastAttemptAt: 1000,
        status: "pending",
      };
      vi.mocked(getTimedOutDms).mockReturnValue([timedOutDm]);

      const cfg = {} as OpenClawConfig;
      startDmRetryScheduler(cfg);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(markDmFailed).toHaveBeenCalledWith("dm-1");
      // sendMessageDiscord should not be called for notification
      expect(sendMessageDiscord).not.toHaveBeenCalled();
    });
  });

  describe("stopDmRetryScheduler", () => {
    it("clears interval and logs", () => {
      vi.mocked(resolveDmRetryConfig).mockReturnValue({
        enabled: true,
        timeoutMs: 300000,
        maxAttempts: 3,
        backoffMs: 60000,
        notifyOnFailure: true,
      });

      const cfg = {} as OpenClawConfig;
      startDmRetryScheduler(cfg);
      vi.clearAllMocks();

      stopDmRetryScheduler();

      expect(logVerbose).toHaveBeenCalledWith("dm-retry: scheduler stopped");
    });

    it("does nothing when not running", () => {
      stopDmRetryScheduler();

      expect(logVerbose).not.toHaveBeenCalled();
    });
  });

  describe("updateSchedulerConfig", () => {
    it("starts scheduler when transitioning from disabled to enabled", () => {
      const disabledCfg = { disabled: true } as unknown as OpenClawConfig;
      const enabledCfg = { enabled: true } as unknown as OpenClawConfig;

      vi.mocked(resolveDmRetryConfig).mockImplementation((cfg) => ({
        enabled: cfg === enabledCfg,
        timeoutMs: 300000,
        maxAttempts: 3,
        backoffMs: 60000,
        notifyOnFailure: true,
      }));

      updateSchedulerConfig(disabledCfg);
      vi.clearAllMocks();

      updateSchedulerConfig(enabledCfg);

      expect(logVerbose).toHaveBeenCalledWith("dm-retry: scheduler started");
    });

    it("stops scheduler when transitioning from enabled to disabled", () => {
      const enabledCfg = { enabled: true } as unknown as OpenClawConfig;
      const disabledCfg = { disabled: true } as unknown as OpenClawConfig;

      vi.mocked(resolveDmRetryConfig).mockImplementation((cfg) => ({
        enabled: cfg === enabledCfg,
        timeoutMs: 300000,
        maxAttempts: 3,
        backoffMs: 60000,
        notifyOnFailure: true,
      }));

      startDmRetryScheduler(enabledCfg);
      vi.clearAllMocks();

      updateSchedulerConfig(disabledCfg);

      expect(logVerbose).toHaveBeenCalledWith("dm-retry: scheduler stopped");
    });
  });
});
