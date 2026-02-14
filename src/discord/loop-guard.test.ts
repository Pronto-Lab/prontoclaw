import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  isSelfMessage,
  checkA2ARateLimit,
  checkA2ADepthLimit,
  resetLoopGuard,
} from "./loop-guard.js";

describe("loop-guard", () => {
  beforeEach(() => {
    resetLoopGuard();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isSelfMessage", () => {
    it("detects self-message", () => {
      expect(isSelfMessage("app-123", "app-123")).toBe(true);
    });

    it("allows different application", () => {
      expect(isSelfMessage("app-456", "app-123")).toBe(false);
    });

    it("handles undefined gracefully", () => {
      expect(isSelfMessage(undefined, "app-123")).toBe(false);
      expect(isSelfMessage("app-123", undefined)).toBe(false);
      expect(isSelfMessage(undefined, undefined)).toBe(false);
    });
  });

  describe("checkA2ARateLimit", () => {
    it("allows messages under the limit", () => {
      for (let i = 0; i < 10; i++) {
        expect(checkA2ARateLimit("a", "b", { maxMessagesPerWindow: 10 })).toBe(false);
      }
    });

    it("blocks when rate limit exceeded", () => {
      for (let i = 0; i < 10; i++) {
        checkA2ARateLimit("a", "b", { maxMessagesPerWindow: 10 });
      }
      expect(checkA2ARateLimit("a", "b", { maxMessagesPerWindow: 10 })).toBe(true);
    });

    it("shares bucket regardless of direction", () => {
      for (let i = 0; i < 5; i++) {
        checkA2ARateLimit("a", "b", { maxMessagesPerWindow: 10 });
      }
      for (let i = 0; i < 5; i++) {
        checkA2ARateLimit("b", "a", { maxMessagesPerWindow: 10 });
      }
      expect(checkA2ARateLimit("a", "b", { maxMessagesPerWindow: 10 })).toBe(true);
    });

    it("expires old entries after window", () => {
      for (let i = 0; i < 10; i++) {
        checkA2ARateLimit("a", "b", { maxMessagesPerWindow: 10, windowMs: 1000 });
      }
      vi.advanceTimersByTime(1100);
      expect(checkA2ARateLimit("a", "b", { maxMessagesPerWindow: 10, windowMs: 1000 })).toBe(false);
    });

    it("different pairs have separate limits", () => {
      for (let i = 0; i < 10; i++) {
        checkA2ARateLimit("a", "b", { maxMessagesPerWindow: 10 });
      }
      expect(checkA2ARateLimit("a", "c", { maxMessagesPerWindow: 10 })).toBe(false);
    });
  });

  describe("checkA2ADepthLimit", () => {
    it("allows within depth", () => {
      expect(checkA2ADepthLimit(3, { maxDepth: 5 })).toBe(false);
    });

    it("allows exactly at limit", () => {
      expect(checkA2ADepthLimit(5, { maxDepth: 5 })).toBe(false);
    });

    it("blocks over limit", () => {
      expect(checkA2ADepthLimit(6, { maxDepth: 5 })).toBe(true);
    });

    it("uses default depth of 5", () => {
      expect(checkA2ADepthLimit(5)).toBe(false);
      expect(checkA2ADepthLimit(6)).toBe(true);
    });
  });

  describe("M2 - per-pair overrides", () => {
    it("pair override allows higher limit than default", () => {
      const config = {
        maxMessagesPerWindow: 5,
        overrides: {
          "a::b": { maxMessagesPerWindow: 10 },
        },
      };
      for (let i = 0; i < 6; i++) {
        expect(checkA2ARateLimit("a", "b", config)).toBe(false);
      }
      expect(checkA2ARateLimit("a", "b", config)).toBe(false);
    });

    it("pair override enforces tighter limit", () => {
      const config = {
        maxMessagesPerWindow: 10,
        overrides: {
          "a::b": { maxMessagesPerWindow: 3 },
        },
      };
      for (let i = 0; i < 3; i++) {
        expect(checkA2ARateLimit("a", "b", config)).toBe(false);
      }
      expect(checkA2ARateLimit("a", "b", config)).toBe(true);
    });

    it("pair override works regardless of direction", () => {
      const config = {
        maxMessagesPerWindow: 10,
        overrides: {
          "a::b": { maxMessagesPerWindow: 5 },
        },
      };
      for (let i = 0; i < 5; i++) {
        expect(checkA2ARateLimit("b", "a", config)).toBe(false);
      }
      expect(checkA2ARateLimit("b", "a", config)).toBe(true);
    });

    it("no override falls back to default config", () => {
      const config = {
        maxMessagesPerWindow: 10,
        overrides: {
          "a::b": { maxMessagesPerWindow: 5 },
        },
      };
      for (let i = 0; i < 10; i++) {
        expect(checkA2ARateLimit("a", "c", config)).toBe(false);
      }
      expect(checkA2ARateLimit("a", "c", config)).toBe(true);
    });

    it("multiple pairs have independent overrides", () => {
      const config = {
        maxMessagesPerWindow: 10,
        overrides: {
          "a::b": { maxMessagesPerWindow: 5 },
          "c::d": { maxMessagesPerWindow: 3 },
        },
      };
      for (let i = 0; i < 5; i++) {
        expect(checkA2ARateLimit("a", "b", config)).toBe(false);
      }
      expect(checkA2ARateLimit("a", "b", config)).toBe(true);
      for (let i = 0; i < 3; i++) {
        expect(checkA2ARateLimit("c", "d", config)).toBe(false);
      }
      expect(checkA2ARateLimit("c", "d", config)).toBe(true);
    });

    it("pair override with custom windowMs", () => {
      const config = {
        maxMessagesPerWindow: 10,
        windowMs: 1000,
        overrides: {
          "a::b": { maxMessagesPerWindow: 5, windowMs: 500 },
        },
      };
      for (let i = 0; i < 5; i++) {
        expect(checkA2ARateLimit("a", "b", config)).toBe(false);
      }
      expect(checkA2ARateLimit("a", "b", config)).toBe(true);
      vi.advanceTimersByTime(600);
      expect(checkA2ARateLimit("a", "b", config)).toBe(false);
    });

    it("override key is always alphabetically sorted", () => {
      const config = {
        maxMessagesPerWindow: 10,
        overrides: {
          "a::b": { maxMessagesPerWindow: 5 },
        },
      };
      for (let i = 0; i < 5; i++) {
        expect(checkA2ARateLimit("b", "a", config)).toBe(false);
      }
      expect(checkA2ARateLimit("b", "a", config)).toBe(true);
    });
  });
});
