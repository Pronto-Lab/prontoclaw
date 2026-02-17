import { describe, expect, it } from "vitest";
import {
  enrichCoordinationEvent,
  resolveMainAgentIdsFromConfig,
} from "../../scripts/task-monitor-server.ts";

describe("task-monitor event enrichment", () => {
  it("resolves main agent ids from agents.list schema", () => {
    const ids = resolveMainAgentIdsFromConfig({
      agents: {
        defaults: {},
        list: [{ id: "eden" }, { id: "seum" }, { id: "worker-quick" }],
      },
    });

    expect(ids.has("eden")).toBe(true);
    expect(ids.has("seum")).toBe(true);
    expect(ids.has("worker-quick")).toBe(true);
    expect(ids.has("main")).toBe(true);
    expect(ids.has("ruda")).toBe(true);
    expect(ids.has("list")).toBe(false);
    expect(ids.has("defaults")).toBe(false);
  });

  it("classifies spawn chain as delegation.subagent", () => {
    const enriched = enrichCoordinationEvent({
      type: "a2a.spawn",
      agentId: "ruda",
      ts: Date.now(),
      data: {
        fromAgent: "ruda",
        toAgent: "worker-quick",
        targetSessionKey: "agent:worker-quick:subagent:abc",
        message: "구현 리뷰 진행",
        workSessionId: "ws_demo",
      },
    });

    expect(enriched).not.toBeNull();
    expect(enriched?.eventRole).toBe("delegation.subagent");
    expect(enriched?.fromSessionType).toBe("main");
    expect(enriched?.toSessionType).toBe("subagent");
    expect(enriched?.data?.eventRole).toBe("delegation.subagent");
  });

  it("classifies main-main send as conversation.main", () => {
    const enriched = enrichCoordinationEvent({
      type: "a2a.send",
      agentId: "ruda",
      ts: Date.now(),
      data: {
        fromAgent: "ruda",
        toAgent: "main",
        message: "코드 구현 진행 상황 공유",
        conversationId: "conv-main-1",
      },
    });

    expect(enriched).not.toBeNull();
    expect(enriched?.eventRole).toBe("conversation.main");
    expect(enriched?.collabCategory).toBe("engineering_build");
  });

  it("classifies task events as orchestration.task", () => {
    const enriched = enrichCoordinationEvent({
      type: "task.updated",
      agentId: "ruda",
      ts: Date.now(),
      data: {
        taskId: "task_123",
        progress: "step 2/4",
      },
    });

    expect(enriched).not.toBeNull();
    expect(enriched?.eventRole).toBe("orchestration.task");
    expect(enriched?.collabCategory).toBe("planning_decision");
  });

  it("classifies QA intent keywords to qa_validation", () => {
    const enriched = enrichCoordinationEvent({
      type: "a2a.response",
      agentId: "ruda",
      ts: Date.now(),
      data: {
        fromAgent: "ruda",
        toAgent: "main",
        replyPreview: "E2E 테스트와 회귀 검증을 완료했습니다",
      },
    });

    expect(enriched).not.toBeNull();
    expect(enriched?.collabCategory).toBe("qa_validation");
    expect(enriched?.categorySource).toBe("rule");
  });
});
