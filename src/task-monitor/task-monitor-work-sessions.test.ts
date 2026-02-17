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
});
