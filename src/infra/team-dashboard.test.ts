import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startTeamDashboard } from "./team-dashboard.js";
import * as teamState from "./team-state.js";

describe("team-dashboard", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: "msg-123" }),
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts initial dashboard on start", async () => {
    vi.spyOn(teamState, "readTeamState").mockResolvedValue({
      version: 1,
      agents: {
        "agent-1": { status: "active", currentTaskId: "task_abc", lastActivityMs: Date.now() },
      },
      lastUpdatedMs: Date.now(),
    });

    const stop = startTeamDashboard({
      webhookUrl: "https://discord.com/api/webhooks/test",
      workspaceDir: "/tmp/test",
      intervalMs: 10000,
    });

    // Let the first tick complete
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.embeds[0].title).toBe("🤖 Agent Team Dashboard");
    expect(body.embeds[0].fields).toHaveLength(1);
    expect(body.embeds[0].fields[0].name).toContain("agent-1");

    stop();
  });

  it("edits existing message on subsequent ticks", async () => {
    vi.spyOn(teamState, "readTeamState").mockResolvedValue({
      version: 1,
      agents: {
        "agent-1": { status: "idle", currentTaskId: null, lastActivityMs: Date.now() },
      },
      lastUpdatedMs: Date.now(),
    });

    const stop = startTeamDashboard({
      webhookUrl: "https://discord.com/api/webhooks/test",
      workspaceDir: "/tmp/test",
      intervalMs: 5000,
    });

    // First tick — creates message
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second tick — should PATCH
    await vi.advanceTimersByTimeAsync(5100);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondCall = fetchSpy.mock.calls[1];
    expect(secondCall[0]).toContain("/messages/msg-123");
    expect(secondCall[1].method).toBe("PATCH");

    stop();
  });

  it("handles empty team state gracefully", async () => {
    vi.spyOn(teamState, "readTeamState").mockResolvedValue(null);

    const stop = startTeamDashboard({
      webhookUrl: "https://discord.com/api/webhooks/test",
      workspaceDir: "/tmp/test",
      intervalMs: 10000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.embeds[0].description).toContain("0 agent(s)");

    stop();
  });

  it("stop() cancels timer", async () => {
    vi.spyOn(teamState, "readTeamState").mockResolvedValue(null);

    const stop = startTeamDashboard({
      webhookUrl: "https://discord.com/api/webhooks/test",
      workspaceDir: "/tmp/test",
      intervalMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(0);
    stop();

    await vi.advanceTimersByTimeAsync(20000);
    // Only 1 call (the initial tick)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
