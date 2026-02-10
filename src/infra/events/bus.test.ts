import { describe, it, expect, vi, beforeEach } from "vitest";
import { emit, subscribe, reset, type CoordinationEvent } from "./bus.js";

beforeEach(() => {
  reset();
});

describe("event bus", () => {
  it("delivers events to type-specific subscribers", () => {
    const handler = vi.fn();
    subscribe("task.started", handler);

    const event: CoordinationEvent = {
      type: "task.started",
      agentId: "main",
      ts: Date.now(),
      data: { taskId: "t1" },
    };
    emit(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it("delivers events to wildcard subscribers", () => {
    const handler = vi.fn();
    subscribe("*", handler);

    const event: CoordinationEvent = {
      type: "task.completed",
      agentId: "main",
      ts: Date.now(),
      data: { taskId: "t1" },
    };
    emit(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it("does not deliver to unrelated subscribers", () => {
    const handler = vi.fn();
    subscribe("task.started", handler);

    emit({
      type: "task.completed",
      agentId: "main",
      ts: Date.now(),
      data: {},
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribes correctly", () => {
    const handler = vi.fn();
    const unsub = subscribe("task.started", handler);

    unsub();

    emit({
      type: "task.started",
      agentId: "main",
      ts: Date.now(),
      data: {},
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("handles listener errors gracefully", () => {
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const after = vi.fn();

    subscribe("task.started", throwing);
    subscribe("task.started", after);

    emit({
      type: "task.started",
      agentId: "main",
      ts: Date.now(),
      data: {},
    });

    expect(throwing).toHaveBeenCalled();
    expect(after).toHaveBeenCalled();
  });

  it("reset clears all listeners", () => {
    const handler = vi.fn();
    subscribe("task.started", handler);
    subscribe("*", handler);

    reset();

    emit({
      type: "task.started",
      agentId: "main",
      ts: Date.now(),
      data: {},
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
