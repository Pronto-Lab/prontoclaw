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
});
