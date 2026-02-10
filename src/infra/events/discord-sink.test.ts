import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emit, reset } from "./bus.js";
import { startDiscordSink } from "./discord-sink.js";
import { EVENT_TYPES } from "./schemas.js";

describe("discord-sink", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reset();
    vi.useFakeTimers();
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("batches events and sends to webhook", async () => {
    const stop = startDiscordSink({
      webhookUrl: "https://discord.com/api/webhooks/test",
      batchWindowMs: 100,
    });

    emit({
      type: EVENT_TYPES.TASK_STARTED,
      agentId: "agent-1",
      ts: Date.now(),
      data: { taskId: "task_abc" },
    });

    emit({
      type: EVENT_TYPES.TASK_COMPLETED,
      agentId: "agent-1",
      ts: Date.now(),
      data: { taskId: "task_abc" },
    });

    // Advance past batch window
    await vi.advanceTimersByTimeAsync(200);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.embeds).toHaveLength(2);
    expect(body.embeds[0].title).toBe("task.started");
    expect(body.embeds[1].title).toBe("task.completed");

    stop();
  });

  it("respects event filter", async () => {
    const stop = startDiscordSink({
      webhookUrl: "https://discord.com/api/webhooks/test",
      batchWindowMs: 100,
      eventFilter: [EVENT_TYPES.TASK_COMPLETED],
    });

    emit({
      type: EVENT_TYPES.TASK_STARTED,
      agentId: "agent-1",
      ts: Date.now(),
      data: {},
    });

    emit({
      type: EVENT_TYPES.TASK_COMPLETED,
      agentId: "agent-1",
      ts: Date.now(),
      data: {},
    });

    await vi.advanceTimersByTimeAsync(200);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toBe("task.completed");

    stop();
  });

  it("force-flushes when maxBatchSize is reached", async () => {
    const stop = startDiscordSink({
      webhookUrl: "https://discord.com/api/webhooks/test",
      batchWindowMs: 10000,
      maxBatchSize: 2,
    });

    emit({
      type: EVENT_TYPES.TASK_STARTED,
      agentId: "a",
      ts: Date.now(),
      data: {},
    });
    emit({
      type: EVENT_TYPES.TASK_COMPLETED,
      agentId: "a",
      ts: Date.now(),
      data: {},
    });

    // Should flush immediately without waiting for timer
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    stop();
  });

  it("stop() unsubscribes and does final flush", async () => {
    const stop = startDiscordSink({
      webhookUrl: "https://discord.com/api/webhooks/test",
      batchWindowMs: 60000,
    });

    emit({
      type: EVENT_TYPES.TASK_STARTED,
      agentId: "a",
      ts: Date.now(),
      data: {},
    });

    stop();

    // Final flush should have sent the queued event
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Subsequent events should not be forwarded
    emit({
      type: EVENT_TYPES.TASK_STARTED,
      agentId: "b",
      ts: Date.now(),
      data: {},
    });

    await vi.advanceTimersByTimeAsync(70000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
