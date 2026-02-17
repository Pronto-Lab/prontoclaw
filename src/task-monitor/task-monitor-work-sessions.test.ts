import { describe, expect, it } from "vitest";
import {
  buildWorkSessionsFromEvents,
  enrichCoordinationEvent,
} from "../../scripts/task-monitor-server.ts";

describe("task-monitor work session aggregation", () => {
  it("separates conversation threads within same work session by conversationId", () => {
    const now = Date.UTC(2026, 1, 17, 12, 0, 0);
    const wsId = "ws_demo_01";

    const events = [
      enrichCoordinationEvent({
        type: "a2a.send",
        ts: now - 30_000,
        data: {
          workSessionId: wsId,
          conversationId: "conv-a",
          fromAgent: "eden",
          toAgent: "seum",
          message: "first thread",
        },
      }),
      enrichCoordinationEvent({
        type: "a2a.send",
        ts: now - 10_000,
        data: {
          workSessionId: wsId,
          conversationId: "conv-b",
          fromAgent: "eden",
          toAgent: "seum",
          message: "second thread",
        },
      }),
    ].filter((event): event is NonNullable<typeof event> => !!event);

    const sessions = buildWorkSessionsFromEvents(events, { nowMs: now });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.threads).toHaveLength(2);
    expect(
      sessions[0]?.threads
        .map((thread) => thread.conversationId)
        .toSorted((a, b) => String(a ?? "").localeCompare(String(b ?? ""))),
    ).toEqual(["conv-a", "conv-b"]);
  });

  it("classifies session as QUIET when latest event is complete and ARCHIVED after 24h", () => {
    const base = Date.UTC(2026, 1, 17, 9, 0, 0);
    const wsId = "ws_demo_02";

    const events = [
      enrichCoordinationEvent({
        type: "a2a.send",
        ts: base,
        data: {
          workSessionId: wsId,
          conversationId: "conv-q",
          fromAgent: "ruda",
          toAgent: "eden",
          message: "run",
        },
      }),
      enrichCoordinationEvent({
        type: "a2a.complete",
        ts: base + 5_000,
        data: {
          workSessionId: wsId,
          conversationId: "conv-q",
          fromAgent: "ruda",
          toAgent: "eden",
        },
      }),
    ].filter((event): event is NonNullable<typeof event> => !!event);

    const quiet = buildWorkSessionsFromEvents(events, { nowMs: base + 60_000 });
    expect(quiet[0]?.status).toBe("QUIET");

    const archived = buildWorkSessionsFromEvents(events, {
      nowMs: base + 24 * 60 * 60 * 1000 + 6_000,
    });
    expect(archived[0]?.status).toBe("ARCHIVED");
  });

  it("classifies session as ACTIVE when there is non-terminal recent activity", () => {
    const base = Date.UTC(2026, 1, 17, 10, 0, 0);
    const wsId = "ws_demo_03";

    const events = [
      enrichCoordinationEvent({
        type: "a2a.send",
        ts: base,
        data: {
          workSessionId: wsId,
          conversationId: "conv-active",
          fromAgent: "ruda",
          toAgent: "eden",
          message: "please check",
        },
      }),
      enrichCoordinationEvent({
        type: "a2a.response",
        ts: base + 5_000,
        data: {
          workSessionId: wsId,
          conversationId: "conv-active",
          fromAgent: "eden",
          toAgent: "ruda",
          replyPreview: "working on it",
        },
      }),
    ].filter((event): event is NonNullable<typeof event> => !!event);

    const sessions = buildWorkSessionsFromEvents(events, { nowMs: base + 30_000 });
    expect(sessions[0]?.status).toBe("ACTIVE");
  });

  it("applies manual category override when provided", () => {
    const now = Date.UTC(2026, 1, 17, 15, 0, 0);
    const wsId = "ws_demo_04";
    const events = [
      enrichCoordinationEvent({
        type: "a2a.send",
        ts: now - 2_000,
        data: {
          workSessionId: wsId,
          conversationId: "conv-override",
          fromAgent: "ruda",
          toAgent: "eden",
          message: "deploy config update",
          collabCategory: "infra_ops",
        },
      }),
    ].filter((event): event is NonNullable<typeof event> => !!event);

    const sessions = buildWorkSessionsFromEvents(events, {
      nowMs: now,
      categoryOverrides: {
        [wsId]: {
          collabCategory: "qa_validation",
          updatedAt: new Date(now).toISOString(),
          updatedBy: "ops-admin",
        },
      },
    });

    expect(sessions[0]?.collabCategory).toBe("qa_validation");
    expect(sessions[0]?.categorySource).toBe("manual_override");
  });

  it("filters aggregated work sessions by requested role", () => {
    const now = Date.UTC(2026, 1, 17, 16, 0, 0);
    const wsId = "ws_demo_05";
    const events = [
      enrichCoordinationEvent({
        type: "a2a.send",
        ts: now - 20_000,
        data: {
          workSessionId: wsId,
          conversationId: "conv-main",
          fromAgent: "ruda",
          toAgent: "eden",
          message: "main conversation",
          eventRole: "conversation.main",
        },
      }),
      enrichCoordinationEvent({
        type: "a2a.spawn",
        ts: now - 10_000,
        data: {
          workSessionId: wsId,
          fromAgent: "ruda",
          toAgent: "worker-quick",
          eventRole: "delegation.subagent",
        },
      }),
    ].filter((event): event is NonNullable<typeof event> => !!event);

    const sessions = buildWorkSessionsFromEvents(events, {
      nowMs: now,
      roleFilters: ["conversation.main"],
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.eventCount).toBe(1);
    expect(sessions[0]?.threads).toHaveLength(1);
    expect(sessions[0]?.threads[0]?.conversationId).toBe("conv-main");
    expect(sessions[0]?.roleCounts["conversation.main"]).toBe(1);
    expect(sessions[0]?.roleCounts["delegation.subagent"]).toBe(0);
  });

  it("filters aggregated work session events by requested event types", () => {
    const now = Date.UTC(2026, 1, 17, 17, 0, 0);
    const wsId = "ws_demo_06";
    const events = [
      enrichCoordinationEvent({
        type: "a2a.send",
        ts: now - 20_000,
        data: {
          workSessionId: wsId,
          conversationId: "conv-typed",
          fromAgent: "ruda",
          toAgent: "eden",
          message: "request",
          eventRole: "conversation.main",
        },
      }),
      enrichCoordinationEvent({
        type: "a2a.response",
        ts: now - 10_000,
        data: {
          workSessionId: wsId,
          conversationId: "conv-typed",
          fromAgent: "eden",
          toAgent: "ruda",
          message: "result payload",
          eventRole: "conversation.main",
        },
      }),
      enrichCoordinationEvent({
        type: "a2a.complete",
        ts: now - 2_000,
        data: {
          workSessionId: wsId,
          conversationId: "conv-typed",
          fromAgent: "ruda",
          toAgent: "eden",
          eventRole: "conversation.main",
        },
      }),
    ].filter((event): event is NonNullable<typeof event> => !!event);

    const sessions = buildWorkSessionsFromEvents(events, {
      nowMs: now,
      roleFilters: ["conversation.main"],
      eventTypeFilters: ["a2a.response"],
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.eventCount).toBe(1);
    expect(sessions[0]?.threads).toHaveLength(1);
    expect(sessions[0]?.threads[0]?.eventCount).toBe(1);
    expect(sessions[0]?.threads[0]?.events.map((event) => event.type)).toEqual(["a2a.response"]);
  });

  it("ignores invalid event type filters and keeps valid ones", () => {
    const now = Date.UTC(2026, 1, 17, 18, 0, 0);
    const wsId = "ws_demo_07";
    const events = [
      enrichCoordinationEvent({
        type: "a2a.send",
        ts: now - 20_000,
        data: {
          workSessionId: wsId,
          conversationId: "conv-invalid-filter",
          fromAgent: "ruda",
          toAgent: "eden",
          message: "request",
          eventRole: "conversation.main",
        },
      }),
      enrichCoordinationEvent({
        type: "a2a.response",
        ts: now - 10_000,
        data: {
          workSessionId: wsId,
          conversationId: "conv-invalid-filter",
          fromAgent: "eden",
          toAgent: "ruda",
          message: "result",
          eventRole: "conversation.main",
        },
      }),
    ].filter((event): event is NonNullable<typeof event> => !!event);

    const sessions = buildWorkSessionsFromEvents(events, {
      nowMs: now,
      eventTypeFilters: ["", "a2a.response", "unknown.event"],
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.eventCount).toBe(1);
    expect(sessions[0]?.threads[0]?.events.map((event) => event.type)).toEqual(["a2a.response"]);
  });
});
