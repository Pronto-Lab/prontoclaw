import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  A2AConcurrencyError,
  A2AConcurrencyGateImpl,
  initA2AConcurrencyGate,
  getA2AConcurrencyGate,
  resetA2AConcurrencyGate,
  type A2AConcurrencyConfig,
} from "./a2a-concurrency.js";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

function makeGate(config?: Partial<A2AConcurrencyConfig>): A2AConcurrencyGateImpl {
  return new A2AConcurrencyGateImpl({
    maxConcurrentFlows: config?.maxConcurrentFlows ?? 3,
    queueTimeoutMs: config?.queueTimeoutMs ?? 5000,
  });
}

describe("A2AConcurrencyGateImpl", () => {
  describe("acquire / release", () => {
    it("grants permits immediately when under limit", async () => {
      const gate = makeGate({ maxConcurrentFlows: 3 });
      await gate.acquire("agent-1", "flow-1");
      await gate.acquire("agent-1", "flow-2");
      await gate.acquire("agent-1", "flow-3");
      expect(gate.activeCount("agent-1")).toBe(3);
    });

    it("queues when limit is reached, then grants after release", async () => {
      const gate = makeGate({ maxConcurrentFlows: 1 });
      await gate.acquire("agent-1", "flow-1");
      expect(gate.activeCount("agent-1")).toBe(1);

      const flow2Promise = gate.acquire("agent-1", "flow-2");
      expect(gate.queuedCount("agent-1")).toBe(1);

      gate.release("agent-1", "flow-1");
      await flow2Promise;
      expect(gate.activeCount("agent-1")).toBe(1);
      expect(gate.queuedCount("agent-1")).toBe(0);
    });

    it("handles multiple queued flows in FIFO order", async () => {
      const gate = makeGate({ maxConcurrentFlows: 1 });
      const order: string[] = [];

      await gate.acquire("agent-1", "flow-1");

      const p2 = gate.acquire("agent-1", "flow-2").then(() => order.push("flow-2"));
      const p3 = gate.acquire("agent-1", "flow-3").then(() => order.push("flow-3"));

      expect(gate.queuedCount("agent-1")).toBe(2);

      gate.release("agent-1", "flow-1");
      await p2;
      gate.release("agent-1", "flow-2");
      await p3;

      expect(order).toEqual(["flow-2", "flow-3"]);
    });

    it("release cleans up active count correctly", async () => {
      const gate = makeGate({ maxConcurrentFlows: 3 });
      await gate.acquire("agent-1", "flow-1");
      await gate.acquire("agent-1", "flow-2");
      expect(gate.activeCount("agent-1")).toBe(2);

      gate.release("agent-1", "flow-1");
      expect(gate.activeCount("agent-1")).toBe(1);

      gate.release("agent-1", "flow-2");
      expect(gate.activeCount("agent-1")).toBe(0);
    });

    it("release with no active count is a no-op", () => {
      const gate = makeGate();
      gate.release("agent-1", "flow-1");
      expect(gate.activeCount("agent-1")).toBe(0);
    });
  });

  describe("agent isolation", () => {
    it("different agents have independent counters", async () => {
      const gate = makeGate({ maxConcurrentFlows: 1 });
      await gate.acquire("agent-1", "flow-1");
      await gate.acquire("agent-2", "flow-1");
      expect(gate.activeCount("agent-1")).toBe(1);
      expect(gate.activeCount("agent-2")).toBe(1);
    });

    it("releasing one agent does not affect another", async () => {
      const gate = makeGate({ maxConcurrentFlows: 1 });
      await gate.acquire("agent-1", "flow-1");
      await gate.acquire("agent-2", "flow-1");

      gate.release("agent-1", "flow-1");
      expect(gate.activeCount("agent-1")).toBe(0);
      expect(gate.activeCount("agent-2")).toBe(1);
    });
  });

  describe("timeout", () => {
    it("throws A2AConcurrencyError on timeout", async () => {
      const gate = makeGate({ maxConcurrentFlows: 1, queueTimeoutMs: 50 });
      await gate.acquire("agent-1", "flow-1");

      await expect(gate.acquire("agent-1", "flow-2")).rejects.toThrow(A2AConcurrencyError);
    });

    it("error contains agent info", async () => {
      const gate = makeGate({ maxConcurrentFlows: 1, queueTimeoutMs: 50 });
      await gate.acquire("agent-1", "flow-1");

      try {
        await gate.acquire("agent-1", "flow-2");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(A2AConcurrencyError);
        const concErr = err as A2AConcurrencyError;
        expect(concErr.agentId).toBe("agent-1");
        expect(concErr.flowId).toBe("flow-2");
        expect(concErr.queueTimeoutMs).toBe(50);
      }
    });

    it("cleans up queue entry on timeout", async () => {
      const gate = makeGate({ maxConcurrentFlows: 1, queueTimeoutMs: 50 });
      await gate.acquire("agent-1", "flow-1");

      await expect(gate.acquire("agent-1", "flow-2")).rejects.toThrow();
      expect(gate.queuedCount("agent-1")).toBe(0);
    });
  });

  describe("counts", () => {
    it("returns 0 for unknown agents", () => {
      const gate = makeGate();
      expect(gate.activeCount("unknown")).toBe(0);
      expect(gate.queuedCount("unknown")).toBe(0);
    });
  });
});

describe("module-level singleton", () => {
  beforeEach(() => {
    resetA2AConcurrencyGate();
  });

  afterEach(() => {
    resetA2AConcurrencyGate();
  });

  it("returns null before initialization", () => {
    expect(getA2AConcurrencyGate()).toBeNull();
  });

  it("returns gate after initialization", () => {
    initA2AConcurrencyGate();
    expect(getA2AConcurrencyGate()).not.toBeNull();
  });

  it("accepts custom config", async () => {
    initA2AConcurrencyGate({ maxConcurrentFlows: 5 });
    const gate = getA2AConcurrencyGate()!;
    // Should be able to acquire 5 permits
    for (let i = 0; i < 5; i++) {
      await gate.acquire("agent-1", `flow-${i}`);
    }
    expect(gate.activeCount("agent-1")).toBe(5);
  });
});
