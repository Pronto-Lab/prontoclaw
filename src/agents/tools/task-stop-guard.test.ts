import { describe, expect, it } from "vitest";
import type { TaskFile } from "./task-file-io.js";
import { checkStopGuard, formatStopGuardError } from "./task-stop-guard.js";

function makeTask(overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    id: "task_test123",
    status: "in_progress",
    priority: "medium",
    description: "Test task",
    created: "2026-01-01T00:00:00Z",
    lastActivity: "2026-01-01T00:00:00Z",
    progress: [],
    ...overrides,
  };
}

function makeStep(
  status: "pending" | "in_progress" | "done" | "skipped",
  id?: string,
  content?: string,
): { id: string; content: string; status: "pending" | "in_progress" | "done" | "skipped"; order: number } {
  return {
    id: id ?? `s${Math.random().toString(36).slice(2, 6)}`,
    content: content ?? `Step ${id ?? "auto"}`,
    status,
    order: 1,
  };
}

describe("task-stop-guard", () => {
  describe("checkStopGuard", () => {
    it("allows completion when task has no steps", () => {
      const task = makeTask({ steps: undefined });
      const result = checkStopGuard(task);
      expect(result.blocked).toBe(false);
    });

    it("allows completion when steps array is empty", () => {
      const task = makeTask({ steps: [] });
      const result = checkStopGuard(task);
      expect(result.blocked).toBe(false);
    });

    it("allows completion when all steps are done", () => {
      const task = makeTask({
        steps: [makeStep("done", "s1"), makeStep("done", "s2")],
      });
      const result = checkStopGuard(task);
      expect(result.blocked).toBe(false);
    });

    it("allows completion when all steps are skipped", () => {
      const task = makeTask({
        steps: [makeStep("skipped", "s1"), makeStep("skipped", "s2")],
      });
      const result = checkStopGuard(task);
      expect(result.blocked).toBe(false);
    });

    it("allows completion with mix of done and skipped steps", () => {
      const task = makeTask({
        steps: [makeStep("done", "s1"), makeStep("skipped", "s2"), makeStep("done", "s3")],
      });
      const result = checkStopGuard(task);
      expect(result.blocked).toBe(false);
    });

    it("blocks completion when pending steps exist", () => {
      const task = makeTask({
        steps: [makeStep("done", "s1"), makeStep("pending", "s2")],
      });
      const result = checkStopGuard(task);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("1 steps still incomplete");
      expect(result.incompleteSteps).toHaveLength(1);
      expect(result.incompleteSteps![0].id).toBe("s2");
      expect(result.incompleteSteps![0].status).toBe("pending");
    });

    it("blocks completion when in_progress steps exist", () => {
      const task = makeTask({
        steps: [makeStep("in_progress", "s1"), makeStep("done", "s2")],
      });
      const result = checkStopGuard(task);
      expect(result.blocked).toBe(true);
      expect(result.incompleteSteps).toHaveLength(1);
      expect(result.incompleteSteps![0].id).toBe("s1");
      expect(result.incompleteSteps![0].status).toBe("in_progress");
    });

    it("blocks completion with multiple incomplete steps", () => {
      const task = makeTask({
        steps: [
          makeStep("pending", "s1"),
          makeStep("done", "s2"),
          makeStep("in_progress", "s3"),
          makeStep("pending", "s4"),
        ],
      });
      const result = checkStopGuard(task);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("3 steps still incomplete");
      expect(result.incompleteSteps).toHaveLength(3);
      const ids = result.incompleteSteps!.map((s) => s.id);
      expect(ids).toContain("s1");
      expect(ids).toContain("s3");
      expect(ids).toContain("s4");
    });

    it("returns incomplete step content and status", () => {
      const task = makeTask({
        steps: [makeStep("pending", "s1", "Fix the bug")],
      });
      const result = checkStopGuard(task);
      expect(result.blocked).toBe(true);
      expect(result.incompleteSteps![0]).toEqual({
        id: "s1",
        content: "Fix the bug",
        status: "pending",
      });
    });

    it("allows single done step", () => {
      const task = makeTask({
        steps: [makeStep("done", "s1")],
      });
      expect(checkStopGuard(task).blocked).toBe(false);
    });

    it("blocks single pending step", () => {
      const task = makeTask({
        steps: [makeStep("pending", "s1")],
      });
      const result = checkStopGuard(task);
      expect(result.blocked).toBe(true);
      expect(result.incompleteSteps).toHaveLength(1);
    });
  });

  describe("formatStopGuardError", () => {
    it("returns empty string when not blocked", () => {
      const result = formatStopGuardError({ blocked: false });
      expect(result).toBe("");
    });

    it("formats error with reason and steps", () => {
      const result = formatStopGuardError({
        blocked: true,
        reason: "Cannot complete task: 2 steps still incomplete",
        incompleteSteps: [
          { id: "s1", content: "Write tests", status: "pending" },
          { id: "s2", content: "Deploy", status: "in_progress" },
        ],
      });
      expect(result).toContain("Cannot complete task: 2 steps still incomplete");
      expect(result).toContain("s1: Write tests (pending)");
      expect(result).toContain("s2: Deploy (in_progress)");
    });

    it("formats error when incompleteSteps is undefined", () => {
      const result = formatStopGuardError({
        blocked: true,
        reason: "Some reason",
      });
      expect(result).toContain("Some reason");
    });
  });
});
