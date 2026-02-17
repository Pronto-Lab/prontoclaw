import { describe, expect, it } from "vitest";
import { parseTaskFileMd } from "../../scripts/task-monitor-server.ts";

describe("task-monitor-server parseTaskFileMd export", () => {
  it("parses steps progress from real server parser", () => {
    const content = `# Task: task_steps_export

## Metadata
- **Status:** in_progress
- **Priority:** high
- **Created:** 2026-02-16T12:00:00.000Z

## Description
Parser export check

## Steps
- [x] (s1) Collect context
- [>] (s2) Implement fix
- [ ] (s3) Validate

## Progress
- Task started

## Last Activity
2026-02-16T12:30:00.000Z`;

    const task = parseTaskFileMd(content, "task_steps_export.md");

    expect(task).not.toBeNull();
    expect(task?.id).toBe("task_steps_export");
    expect(task?.stepsProgress).toEqual({
      total: 3,
      done: 1,
      inProgress: 1,
      pending: 1,
      skipped: 0,
    });
  });

  it("returns null for no-task marker", () => {
    expect(parseTaskFileMd("*(No task)*", "task_any.md")).toBeNull();
  });

  it("parses work session metadata from real server parser", () => {
    const content = `# Task: task_ws_meta

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-16T12:00:00.000Z
- **Work Session:** ws_abc
- **Previous Work Session:** ws_prev

## Description
Work session parse check

## Progress
- Started

## Last Activity
2026-02-16T12:31:00.000Z`;

    const task = parseTaskFileMd(content, "task_ws_meta.md");
    expect(task).not.toBeNull();
    expect(task?.workSessionId).toBe("ws_abc");
    expect(task?.previousWorkSessionId).toBe("ws_prev");
  });
});
