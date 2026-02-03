import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before imports
vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock("../../config/paths.js", () => ({
  resolveStateDir: vi.fn(() => "/tmp/test-state"),
}));

import fs from "node:fs";
import {
  cleanupOldEntries,
  getTimedOutDms,
  incrementRetryAttempt,
  loadDmRetryStore,
  markDmFailed,
  markDmResponded,
  trackOutboundDm,
  type DmRetryStore,
} from "./tracker.js";

describe("dm-retry tracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("test-uuid-1234");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("loadDmRetryStore", () => {
    it("returns empty store when file does not exist", () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const store = loadDmRetryStore();

      expect(store).toEqual({ version: 1, tracked: {} });
    });

    it("returns empty store when file contains invalid JSON", () => {
      vi.mocked(fs.readFileSync).mockReturnValue("not valid json");

      const store = loadDmRetryStore();

      expect(store).toEqual({ version: 1, tracked: {} });
    });

    it("returns parsed store when file contains valid data", () => {
      const validStore: DmRetryStore = {
        version: 1,
        tracked: {
          "dm-1": {
            id: "dm-1",
            messageId: "msg-1",
            channelId: "ch-1",
            senderAgentId: "agent-1",
            targetUserId: "user-1",
            originalText: "Hello",
            sentAt: 1000,
            attempts: 1,
            lastAttemptAt: 1000,
            status: "pending",
          },
        },
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validStore));

      const store = loadDmRetryStore();

      expect(store).toEqual(validStore);
    });

    it("returns empty store when data is missing required fields", () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ version: 1 }));

      const store = loadDmRetryStore();

      expect(store).toEqual({ version: 1, tracked: {} });
    });
  });

  describe("trackOutboundDm", () => {
    it("adds entry with correct fields", async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);

      const result = await trackOutboundDm({
        messageId: "msg-123",
        channelId: "ch-456",
        senderAgentId: "main",
        targetUserId: "user-789",
        originalText: "Test message",
      });

      expect(result).toEqual({
        id: "test-uuid-1234",
        messageId: "msg-123",
        channelId: "ch-456",
        senderAgentId: "main",
        targetUserId: "user-789",
        originalText: "Test message",
        sentAt: now,
        attempts: 1,
        lastAttemptAt: now,
        status: "pending",
      });

      expect(fs.promises.writeFile).toHaveBeenCalled();
    });
  });

  describe("markDmResponded", () => {
    it("updates status and returns count of updated entries", async () => {
      const store: DmRetryStore = {
        version: 1,
        tracked: {
          "dm-1": {
            id: "dm-1",
            messageId: "msg-1",
            channelId: "ch-target",
            senderAgentId: "agent-1",
            targetUserId: "user-1",
            originalText: "Hello",
            sentAt: 1000,
            attempts: 1,
            lastAttemptAt: 1000,
            status: "pending",
          },
          "dm-2": {
            id: "dm-2",
            messageId: "msg-2",
            channelId: "ch-target",
            senderAgentId: "agent-1",
            targetUserId: "user-1",
            originalText: "World",
            sentAt: 2000,
            attempts: 1,
            lastAttemptAt: 2000,
            status: "pending",
          },
          "dm-3": {
            id: "dm-3",
            messageId: "msg-3",
            channelId: "ch-other",
            senderAgentId: "agent-1",
            targetUserId: "user-2",
            originalText: "Other",
            sentAt: 3000,
            attempts: 1,
            lastAttemptAt: 3000,
            status: "pending",
          },
        },
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

      const count = await markDmResponded("ch-target");

      expect(count).toBe(2);
      expect(fs.promises.writeFile).toHaveBeenCalled();
    });

    it("returns 0 when no matching entries", async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const count = await markDmResponded("ch-nonexistent");

      expect(count).toBe(0);
    });
  });

  describe("getTimedOutDms", () => {
    it("filters correctly based on timeout", () => {
      const now = 10000;
      vi.spyOn(Date, "now").mockReturnValue(now);

      const store: DmRetryStore = {
        version: 1,
        tracked: {
          "dm-old": {
            id: "dm-old",
            messageId: "msg-1",
            channelId: "ch-1",
            senderAgentId: "agent-1",
            targetUserId: "user-1",
            originalText: "Old",
            sentAt: 1000,
            attempts: 1,
            lastAttemptAt: 1000, // 9000ms ago
            status: "pending",
          },
          "dm-new": {
            id: "dm-new",
            messageId: "msg-2",
            channelId: "ch-2",
            senderAgentId: "agent-1",
            targetUserId: "user-2",
            originalText: "New",
            sentAt: 9000,
            attempts: 1,
            lastAttemptAt: 9000, // 1000ms ago
            status: "pending",
          },
          "dm-responded": {
            id: "dm-responded",
            messageId: "msg-3",
            channelId: "ch-3",
            senderAgentId: "agent-1",
            targetUserId: "user-3",
            originalText: "Responded",
            sentAt: 1000,
            attempts: 1,
            lastAttemptAt: 1000,
            status: "responded",
          },
        },
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

      const timedOut = getTimedOutDms(5000); // 5s timeout

      expect(timedOut).toHaveLength(1);
      expect(timedOut[0].id).toBe("dm-old");
    });
  });

  describe("incrementRetryAttempt", () => {
    it("increments attempts and updates timestamp", async () => {
      const store: DmRetryStore = {
        version: 1,
        tracked: {
          "dm-1": {
            id: "dm-1",
            messageId: "msg-1",
            channelId: "ch-1",
            senderAgentId: "agent-1",
            targetUserId: "user-1",
            originalText: "Hello",
            sentAt: 1000,
            attempts: 2,
            lastAttemptAt: 1000,
            status: "pending",
          },
        },
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

      const now = 5000;
      vi.spyOn(Date, "now").mockReturnValue(now);

      const result = await incrementRetryAttempt("dm-1");

      expect(result).not.toBeNull();
      expect(result!.attempts).toBe(3);
      expect(result!.lastAttemptAt).toBe(now);
    });

    it("returns null for non-existent entry", async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const result = await incrementRetryAttempt("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("markDmFailed", () => {
    it("sets status to failed", async () => {
      const store: DmRetryStore = {
        version: 1,
        tracked: {
          "dm-1": {
            id: "dm-1",
            messageId: "msg-1",
            channelId: "ch-1",
            senderAgentId: "agent-1",
            targetUserId: "user-1",
            originalText: "Hello",
            sentAt: 1000,
            attempts: 3,
            lastAttemptAt: 3000,
            status: "pending",
          },
        },
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

      const result = await markDmFailed("dm-1");

      expect(result).not.toBeNull();
      expect(result!.status).toBe("failed");
    });

    it("returns null for non-existent entry", async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const result = await markDmFailed("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("cleanupOldEntries", () => {
    it("removes old non-pending entries", async () => {
      const now = 100000;
      vi.spyOn(Date, "now").mockReturnValue(now);

      const store: DmRetryStore = {
        version: 1,
        tracked: {
          "dm-old-responded": {
            id: "dm-old-responded",
            messageId: "msg-1",
            channelId: "ch-1",
            senderAgentId: "agent-1",
            targetUserId: "user-1",
            originalText: "Old responded",
            sentAt: 1000,
            attempts: 1,
            lastAttemptAt: 1000, // 99000ms ago
            status: "responded",
          },
          "dm-old-pending": {
            id: "dm-old-pending",
            messageId: "msg-2",
            channelId: "ch-2",
            senderAgentId: "agent-1",
            targetUserId: "user-2",
            originalText: "Old pending",
            sentAt: 1000,
            attempts: 1,
            lastAttemptAt: 1000,
            status: "pending", // Should NOT be removed
          },
          "dm-new-failed": {
            id: "dm-new-failed",
            messageId: "msg-3",
            channelId: "ch-3",
            senderAgentId: "agent-1",
            targetUserId: "user-3",
            originalText: "New failed",
            sentAt: 95000,
            attempts: 3,
            lastAttemptAt: 95000, // 5000ms ago
            status: "failed",
          },
        },
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

      const count = await cleanupOldEntries(50000); // 50s max age

      expect(count).toBe(1); // Only dm-old-responded should be removed
    });
  });
});
