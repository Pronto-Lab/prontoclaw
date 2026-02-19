import { describe, it, expect } from "vitest";
import {
  parseA2APayload,
  validateA2APayload,
  buildPayloadSummary,
  mapPayloadTypeToMessageIntent,
} from "./a2a-payload-parser.js";
import type {
  A2APayload,
  TaskDelegationPayload,
  StatusReportPayload,
  QuestionPayload,
  AnswerPayload,
} from "./a2a-payload-types.js";

// ---------------------------------------------------------------------------
// parseA2APayload
// ---------------------------------------------------------------------------

describe("parseA2APayload", () => {
  describe("task_delegation", () => {
    it("parses a valid task_delegation payload", () => {
      const json = JSON.stringify({
        type: "task_delegation",
        taskId: "task-001",
        taskTitle: "Write API docs",
        taskDescription: "Document the sessions_send payloadJson parameter",
        priority: "high",
      });
      const result = parseA2APayload(json);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("task_delegation");
      expect((result as TaskDelegationPayload).taskId).toBe("task-001");
      expect((result as TaskDelegationPayload).priority).toBe("high");
    });

    it("parses task_delegation with all optional fields", () => {
      const json = JSON.stringify({
        type: "task_delegation",
        taskId: "task-002",
        taskTitle: "Full example",
        taskDescription: "Test all fields",
        context: "Some context",
        deadline: "2026-03-01T00:00:00Z",
        priority: "critical",
        acceptanceCriteria: ["Tests pass", "Build succeeds"],
      });
      const result = parseA2APayload(json);
      expect(result).not.toBeNull();
      const td = result as TaskDelegationPayload;
      expect(td.context).toBe("Some context");
      expect(td.deadline).toBe("2026-03-01T00:00:00Z");
      expect(td.acceptanceCriteria).toEqual(["Tests pass", "Build succeeds"]);
    });

    it("returns null when taskId is missing", () => {
      const json = JSON.stringify({
        type: "task_delegation",
        taskTitle: "No ID",
        taskDescription: "Missing taskId",
      });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("returns null when taskTitle is missing", () => {
      const json = JSON.stringify({
        type: "task_delegation",
        taskId: "task-003",
        taskDescription: "Missing title",
      });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("returns null when taskDescription is missing", () => {
      const json = JSON.stringify({
        type: "task_delegation",
        taskId: "task-003",
        taskTitle: "Has title",
      });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("returns null for invalid priority", () => {
      const json = JSON.stringify({
        type: "task_delegation",
        taskId: "task-004",
        taskTitle: "Bad priority",
        taskDescription: "desc",
        priority: "ultra",
      });
      expect(parseA2APayload(json)).toBeNull();
    });
  });

  describe("status_report", () => {
    it("parses a valid status_report payload", () => {
      const json = JSON.stringify({
        type: "status_report",
        taskId: "task-001",
        status: "in_progress",
        completedWork: "Phase 1 done",
        progressPercent: 50,
      });
      const result = parseA2APayload(json);
      expect(result).not.toBeNull();
      const sr = result as StatusReportPayload;
      expect(sr.type).toBe("status_report");
      expect(sr.taskId).toBe("task-001");
      expect(sr.status).toBe("in_progress");
      expect(sr.progressPercent).toBe(50);
    });

    it("returns null for invalid status", () => {
      const json = JSON.stringify({
        type: "status_report",
        taskId: "task-001",
        status: "unknown_status",
      });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("returns null when progressPercent is out of range", () => {
      const json = JSON.stringify({
        type: "status_report",
        taskId: "task-001",
        status: "in_progress",
        progressPercent: 150,
      });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("returns null when progressPercent is negative", () => {
      const json = JSON.stringify({
        type: "status_report",
        taskId: "task-001",
        status: "completed",
        progressPercent: -10,
      });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("parses status_report with blockers and artifacts", () => {
      const json = JSON.stringify({
        type: "status_report",
        taskId: "task-005",
        status: "blocked",
        blockers: ["Waiting for API key", "Build server down"],
        artifacts: ["/tmp/report.md"],
      });
      const result = parseA2APayload(json);
      expect(result).not.toBeNull();
      const sr = result as StatusReportPayload;
      expect(sr.blockers).toEqual(["Waiting for API key", "Build server down"]);
      expect(sr.artifacts).toEqual(["/tmp/report.md"]);
    });
  });

  describe("question", () => {
    it("parses a valid question payload", () => {
      const json = JSON.stringify({
        type: "question",
        questionId: "q-001",
        question: "What is the test coverage threshold?",
        urgency: "normal",
      });
      const result = parseA2APayload(json);
      expect(result).not.toBeNull();
      const q = result as QuestionPayload;
      expect(q.type).toBe("question");
      expect(q.questionId).toBe("q-001");
      expect(q.urgency).toBe("normal");
    });

    it("parses question with options", () => {
      const json = JSON.stringify({
        type: "question",
        questionId: "q-002",
        question: "Which approach?",
        options: ["Option A", "Option B", "Option C"],
      });
      const result = parseA2APayload(json);
      expect(result).not.toBeNull();
      expect((result as QuestionPayload).options).toEqual(["Option A", "Option B", "Option C"]);
    });

    it("returns null when questionId is missing", () => {
      const json = JSON.stringify({
        type: "question",
        question: "No ID",
      });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("returns null when question text is missing", () => {
      const json = JSON.stringify({
        type: "question",
        questionId: "q-003",
      });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("returns null for invalid urgency", () => {
      const json = JSON.stringify({
        type: "question",
        questionId: "q-004",
        question: "Bad urgency",
        urgency: "super",
      });
      expect(parseA2APayload(json)).toBeNull();
    });
  });

  describe("answer", () => {
    it("parses a valid answer payload", () => {
      const json = JSON.stringify({
        type: "answer",
        questionId: "q-001",
        answer: "80% coverage is required",
        confidence: 0.95,
      });
      const result = parseA2APayload(json);
      expect(result).not.toBeNull();
      const a = result as AnswerPayload;
      expect(a.type).toBe("answer");
      expect(a.questionId).toBe("q-001");
      expect(a.confidence).toBe(0.95);
    });

    it("returns null when questionId is missing", () => {
      const json = JSON.stringify({
        type: "answer",
        answer: "Missing qId",
      });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("returns null when answer text is missing", () => {
      const json = JSON.stringify({
        type: "answer",
        questionId: "q-005",
      });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("returns null when confidence exceeds 1.0", () => {
      const json = JSON.stringify({
        type: "answer",
        questionId: "q-001",
        answer: "Yes",
        confidence: 1.5,
      });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("returns null when confidence is negative", () => {
      const json = JSON.stringify({
        type: "answer",
        questionId: "q-001",
        answer: "Yes",
        confidence: -0.1,
      });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("parses answer with references", () => {
      const json = JSON.stringify({
        type: "answer",
        questionId: "q-006",
        answer: "See the docs",
        references: ["https://example.com/docs", "/path/to/file.md"],
      });
      const result = parseA2APayload(json);
      expect(result).not.toBeNull();
      expect((result as AnswerPayload).references).toEqual([
        "https://example.com/docs",
        "/path/to/file.md",
      ]);
    });
  });

  describe("edge cases", () => {
    it("returns null for invalid JSON", () => {
      expect(parseA2APayload("not-json")).toBeNull();
      expect(parseA2APayload("")).toBeNull();
      expect(parseA2APayload("{")).toBeNull();
    });

    it("returns null for non-object JSON", () => {
      expect(parseA2APayload('"string"')).toBeNull();
      expect(parseA2APayload("42")).toBeNull();
      expect(parseA2APayload("true")).toBeNull();
      expect(parseA2APayload("null")).toBeNull();
      expect(parseA2APayload("[]")).toBeNull();
    });

    it("returns null for unknown type", () => {
      const json = JSON.stringify({ type: "unknown_type", data: "..." });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("returns null when type field is missing", () => {
      const json = JSON.stringify({ taskId: "no-type", taskTitle: "oops" });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("returns null when type field is not a string", () => {
      const json = JSON.stringify({ type: 42, taskId: "bad" });
      expect(parseA2APayload(json)).toBeNull();
    });

    it("ignores unknown extra fields (forward compatibility)", () => {
      const json = JSON.stringify({
        type: "question",
        questionId: "q-extra",
        question: "Does it ignore extras?",
        futureField: "should be ignored",
      });
      const result = parseA2APayload(json);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("question");
    });
  });
});

// ---------------------------------------------------------------------------
// validateA2APayload
// ---------------------------------------------------------------------------

describe("validateA2APayload", () => {
  it("returns valid:true for a correct task_delegation", () => {
    const payload: TaskDelegationPayload = {
      type: "task_delegation",
      taskId: "t-1",
      taskTitle: "Title",
      taskDescription: "Desc",
    };
    const result = validateA2APayload(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("returns all errors for multiple missing fields", () => {
    const payload = { type: "task_delegation" } as unknown as TaskDelegationPayload;
    const result = validateA2APayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThanOrEqual(3);
  });

  it("validates status_report status enum", () => {
    const payload: StatusReportPayload = {
      type: "status_report",
      taskId: "t-1",
      status: "invalid" as StatusReportPayload["status"],
    };
    const result = validateA2APayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors![0]).toContain("status must be one of");
  });

  it("validates blockers must be string array", () => {
    const payload = {
      type: "status_report",
      taskId: "t-1",
      status: "blocked",
      blockers: [42],
    } as unknown as StatusReportPayload;
    const result = validateA2APayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes("blockers"))).toBe(true);
  });

  it("validates acceptanceCriteria must be string array", () => {
    const payload = {
      type: "task_delegation",
      taskId: "t-1",
      taskTitle: "T",
      taskDescription: "D",
      acceptanceCriteria: [1, 2, 3],
    } as unknown as TaskDelegationPayload;
    const result = validateA2APayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes("acceptanceCriteria"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildPayloadSummary
// ---------------------------------------------------------------------------

describe("buildPayloadSummary", () => {
  it("summarizes task_delegation", () => {
    const payload: TaskDelegationPayload = {
      type: "task_delegation",
      taskId: "t-1",
      taskTitle: "Code Review",
      taskDescription: "Review PR #42",
      priority: "high",
    };
    const summary = buildPayloadSummary(payload);
    expect(summary).toContain("Task ID: t-1");
    expect(summary).toContain("Title: Code Review");
    expect(summary).toContain("Priority: high");
  });

  it("summarizes status_report with progress", () => {
    const payload: StatusReportPayload = {
      type: "status_report",
      taskId: "t-1",
      status: "in_progress",
      progressPercent: 75,
      completedWork: "Phase 1 & 2",
    };
    const summary = buildPayloadSummary(payload);
    expect(summary).toContain("Status: in_progress");
    expect(summary).toContain("Progress: 75%");
    expect(summary).toContain("Completed: Phase 1 & 2");
  });

  it("summarizes question with options", () => {
    const payload: QuestionPayload = {
      type: "question",
      questionId: "q-1",
      question: "Which approach?",
      urgency: "urgent",
      options: ["A", "B"],
    };
    const summary = buildPayloadSummary(payload);
    expect(summary).toContain("Question ID: q-1");
    expect(summary).toContain("Urgency: urgent");
    expect(summary).toContain("1. A");
    expect(summary).toContain("2. B");
  });

  it("summarizes answer with confidence", () => {
    const payload: AnswerPayload = {
      type: "answer",
      questionId: "q-1",
      answer: "Go with option A",
      confidence: 0.85,
    };
    const summary = buildPayloadSummary(payload);
    expect(summary).toContain("Question ID: q-1");
    expect(summary).toContain("Answer: Go with option A");
    expect(summary).toContain("Confidence: 85%");
  });

  it("omits optional fields that are not provided", () => {
    const payload: TaskDelegationPayload = {
      type: "task_delegation",
      taskId: "t-min",
      taskTitle: "Minimal",
      taskDescription: "No optional fields",
    };
    const summary = buildPayloadSummary(payload);
    expect(summary).not.toContain("Priority");
    expect(summary).not.toContain("Deadline");
    expect(summary).not.toContain("Acceptance");
  });
});

// ---------------------------------------------------------------------------
// mapPayloadTypeToMessageIntent
// ---------------------------------------------------------------------------

describe("mapPayloadTypeToMessageIntent", () => {
  it("maps task_delegation to collaboration", () => {
    expect(mapPayloadTypeToMessageIntent("task_delegation")).toBe("collaboration");
  });

  it("maps status_report to result_report", () => {
    expect(mapPayloadTypeToMessageIntent("status_report")).toBe("result_report");
  });

  it("maps question to question", () => {
    expect(mapPayloadTypeToMessageIntent("question")).toBe("question");
  });

  it("maps answer to notification", () => {
    expect(mapPayloadTypeToMessageIntent("answer")).toBe("notification");
  });
});
