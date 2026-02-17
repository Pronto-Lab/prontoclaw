import { describe, it, expect } from "vitest";
import {
  A2AErrorCategory,
  classifyA2AError,
  calculateBackoffMs,
} from "./a2a-error-classification.js";

describe("classifyA2AError", () => {
  describe("Error instances (gateway connection level)", () => {
    it("classifies timeout errors as TRANSIENT", () => {
      const result = classifyA2AError(new Error("Request timeout"));
      expect(result.category).toBe(A2AErrorCategory.TRANSIENT);
      expect(result.code).toBe("gateway_connection");
      expect(result.retriable).toBe(true);
    });

    it("classifies ECONNRESET as TRANSIENT", () => {
      const result = classifyA2AError(new Error("read ECONNRESET"));
      expect(result.category).toBe(A2AErrorCategory.TRANSIENT);
      expect(result.retriable).toBe(true);
    });

    it("classifies socket hang up as TRANSIENT", () => {
      const result = classifyA2AError(new Error("socket hang up"));
      expect(result.category).toBe(A2AErrorCategory.TRANSIENT);
    });

    it("classifies ECONNREFUSED as TRANSIENT", () => {
      const result = classifyA2AError(new Error("connect ECONNREFUSED 127.0.0.1:18789"));
      expect(result.category).toBe(A2AErrorCategory.TRANSIENT);
    });

    it("classifies DNS errors as TRANSIENT", () => {
      const result = classifyA2AError(new Error("getaddrinfo DNS error"));
      expect(result.category).toBe(A2AErrorCategory.TRANSIENT);
    });

    it("classifies fetch failed as TRANSIENT", () => {
      const result = classifyA2AError(new Error("fetch failed"));
      expect(result.category).toBe(A2AErrorCategory.TRANSIENT);
    });

    it("classifies 401 unauthorized as PERMANENT", () => {
      const result = classifyA2AError(new Error("401 Unauthorized"));
      expect(result.category).toBe(A2AErrorCategory.PERMANENT);
      expect(result.code).toBe("auth_failure");
      expect(result.retriable).toBe(false);
    });

    it("classifies 403 forbidden as PERMANENT", () => {
      const result = classifyA2AError(new Error("403 Forbidden"));
      expect(result.category).toBe(A2AErrorCategory.PERMANENT);
      expect(result.retriable).toBe(false);
    });

    it("classifies unknown errors as UNKNOWN (retriable)", () => {
      const result = classifyA2AError(new Error("Something unexpected happened"));
      expect(result.category).toBe(A2AErrorCategory.UNKNOWN);
      expect(result.code).toBe("gateway_unknown");
      expect(result.retriable).toBe(true);
    });
  });

  describe("agent.wait response objects", () => {
    it("treats status=ok as not-an-error", () => {
      const result = classifyA2AError({ status: "ok" });
      expect(result.code).toBe("ok");
      expect(result.retriable).toBe(false);
    });

    it("classifies not_found as PERMANENT", () => {
      const result = classifyA2AError({ status: "not_found" });
      expect(result.category).toBe(A2AErrorCategory.PERMANENT);
      expect(result.code).toBe("run_not_found");
      expect(result.retriable).toBe(false);
    });

    it("classifies timeout as TRANSIENT", () => {
      const result = classifyA2AError({ status: "timeout" });
      expect(result.category).toBe(A2AErrorCategory.TRANSIENT);
      expect(result.code).toBe("wait_chunk_timeout");
      expect(result.retriable).toBe(true);
    });

    it("classifies rate limit errors as TRANSIENT", () => {
      const result = classifyA2AError({ status: "error", error: "rate_limit exceeded" });
      expect(result.category).toBe(A2AErrorCategory.TRANSIENT);
      expect(result.code).toBe("rate_limit");
      expect(result.retriable).toBe(true);
    });

    it("classifies 429 as TRANSIENT", () => {
      const result = classifyA2AError({ status: "error", error: "429 Too Many Requests" });
      expect(result.category).toBe(A2AErrorCategory.TRANSIENT);
      expect(result.code).toBe("rate_limit");
    });

    it("classifies context length exceeded as PERMANENT", () => {
      const result = classifyA2AError({
        status: "error",
        error: "context_length_exceeded: maximum context window",
      });
      expect(result.category).toBe(A2AErrorCategory.PERMANENT);
      expect(result.code).toBe("context_exceeded");
      expect(result.retriable).toBe(false);
    });

    it("classifies token limit as PERMANENT", () => {
      const result = classifyA2AError({ status: "error", error: "token_limit_exceeded" });
      expect(result.category).toBe(A2AErrorCategory.PERMANENT);
      expect(result.code).toBe("context_exceeded");
    });

    it("classifies server overload as TRANSIENT", () => {
      const result = classifyA2AError({ status: "error", error: "overloaded" });
      expect(result.category).toBe(A2AErrorCategory.TRANSIENT);
      expect(result.code).toBe("server_overload");
      expect(result.retriable).toBe(true);
    });

    it("classifies 502/503 as TRANSIENT", () => {
      expect(classifyA2AError({ status: "error", error: "502 Bad Gateway" }).code).toBe(
        "server_overload",
      );
      expect(classifyA2AError({ status: "error", error: "503 Service Unavailable" }).code).toBe(
        "server_overload",
      );
    });

    it("classifies unknown error status as UNKNOWN (retriable)", () => {
      const result = classifyA2AError({ status: "error", error: "something weird" });
      expect(result.category).toBe(A2AErrorCategory.UNKNOWN);
      expect(result.code).toBe("error_unknown");
      expect(result.retriable).toBe(true);
    });

    it("classifies unexpected status as UNKNOWN (retriable)", () => {
      const result = classifyA2AError({ status: "weird_status" });
      expect(result.category).toBe(A2AErrorCategory.UNKNOWN);
      expect(result.code).toBe("unexpected_status");
      expect(result.retriable).toBe(true);
    });
  });
});

describe("calculateBackoffMs", () => {
  it("returns value within expected range for attempt 0", () => {
    const backoff = calculateBackoffMs(0);
    // base=2000, 2000 * 2^0 = 2000, jitter 50-100% = 1000-2000
    expect(backoff).toBeGreaterThanOrEqual(1000);
    expect(backoff).toBeLessThanOrEqual(2000);
  });

  it("increases exponentially", () => {
    // Collect multiple samples to account for jitter
    const samples0 = Array.from({ length: 20 }, () => calculateBackoffMs(0));
    const samples3 = Array.from({ length: 20 }, () => calculateBackoffMs(3));

    const avg0 = samples0.reduce((a, b) => a + b) / samples0.length;
    const avg3 = samples3.reduce((a, b) => a + b) / samples3.length;

    // attempt 3 should be roughly 8x attempt 0
    expect(avg3).toBeGreaterThan(avg0 * 3);
  });

  it("respects max cap", () => {
    const backoff = calculateBackoffMs(20); // 2000 * 2^20 >> 60000
    expect(backoff).toBeLessThanOrEqual(60_000);
  });

  it("uses custom base and max", () => {
    const backoff = calculateBackoffMs(0, { baseMs: 100, maxMs: 500 });
    expect(backoff).toBeGreaterThanOrEqual(50);
    expect(backoff).toBeLessThanOrEqual(100);
  });
});
