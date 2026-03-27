import { describe, expect, it } from "vitest";
import { expandToolGroups } from "./tool-policy-shared.js";

describe("tool-policy-shared task groups", () => {
  it("expands task and milestone policy groups", () => {
    const expanded = expandToolGroups(["group:task", "group:milestone"]);
    const set = new Set(expanded);

    expect(set.has("task_start")).toBe(true);
    expect(set.has("task_block")).toBe(true);
    expect(set.has("task_resume")).toBe(true);
    expect(set.has("task_backlog_add")).toBe(true);
    expect(set.has("task_pick_backlog")).toBe(true);
    expect(set.has("milestone_create")).toBe(true);
    expect(set.has("milestone_assign_item")).toBe(true);
    expect(set.has("milestone_update_item")).toBe(true);
  });
});
