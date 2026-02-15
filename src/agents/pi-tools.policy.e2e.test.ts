import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { filterToolsByPolicy, isToolAllowedByPolicyName } from "./pi-tools.policy.js";

function createStubTool(name: string): AgentTool<unknown, unknown> {
  return {
    name,
    label: name,
    description: "",
    parameters: {},
    execute: async () => ({}) as AgentToolResult<unknown>,
  };
}

describe("pi-tools.policy", () => {
  it("treats * in allow as allow-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { allow: ["*"] });
    expect(filtered.map((tool) => tool.name)).toEqual(["read", "exec"]);
  });

  it("treats * in deny as deny-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { deny: ["*"] });
    expect(filtered).toEqual([]);
  });

  it("supports wildcard allow/deny patterns", () => {
    expect(isToolAllowedByPolicyName("web_fetch", { allow: ["web_*"] })).toBe(true);
    expect(isToolAllowedByPolicyName("web_search", { deny: ["web_*"] })).toBe(false);
  });

  it("keeps apply_patch when exec is allowlisted", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { allow: ["exec"] })).toBe(true);
  });
});

// [PRONTO-CUSTOM] Sub-agent orchestration: Verify task/milestone tools are in deny list
// See design: /tmp/openclaw-final-design/03-SUBAGENTS.md §1.5
describe("resolveSubagentToolPolicy – task/milestone deny", () => {
  // Import resolveSubagentToolPolicy lazily to avoid import issues
  let resolveSubagentToolPolicy: typeof import("./pi-tools.policy.js").resolveSubagentToolPolicy;

  it("includes all 16 task/milestone tools in default deny list", async () => {
    const mod = await import("./pi-tools.policy.js");
    resolveSubagentToolPolicy = mod.resolveSubagentToolPolicy;

    const policy = resolveSubagentToolPolicy();
    const deny = policy.deny ?? [];

    const expectedTaskTools = [
      "task_start",
      "task_update",
      "task_complete",
      "task_status",
      "task_list",
      "task_cancel",
      "task_block",
      "task_approve",
      "task_resume",
      "task_backlog_add",
      "task_pick_backlog",
    ];
    const expectedMilestoneTools = [
      "milestone_list",
      "milestone_create",
      "milestone_add_item",
      "milestone_assign_item",
      "milestone_update_item",
    ];

    for (const tool of [...expectedTaskTools, ...expectedMilestoneTools]) {
      expect(deny).toContain(tool);
    }
  });

  it("merges config deny with default deny including task tools", async () => {
    const mod = await import("./pi-tools.policy.js");
    resolveSubagentToolPolicy = mod.resolveSubagentToolPolicy;

    const policy = resolveSubagentToolPolicy({
      tools: { subagents: { tools: { deny: ["custom_tool"] } } },
    } as unknown);
    const deny = policy.deny ?? [];

    // Should have both default task tools AND custom deny
    expect(deny).toContain("task_start");
    expect(deny).toContain("milestone_create");
    expect(deny).toContain("custom_tool");
  });

  it("retains existing session/admin deny entries alongside task tools", async () => {
    const mod = await import("./pi-tools.policy.js");
    resolveSubagentToolPolicy = mod.resolveSubagentToolPolicy;

    const policy = resolveSubagentToolPolicy();
    const deny = policy.deny ?? [];

    // Original deny entries should still be present
    expect(deny).toContain("sessions_list");
    expect(deny).toContain("sessions_spawn");
    expect(deny).toContain("gateway");
    expect(deny).toContain("memory_search");
    expect(deny).toContain("cron");
  });
});
