import fs from "node:fs/promises";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    appendFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  },
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue({
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
  appendFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

vi.mock("../agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn((_cfg: unknown, _agentId: unknown) => "/workspace/main"),
  resolveSessionAgentId: vi.fn(() => "main"),
  listAgentIds: vi.fn(() => ["main", "agent1"]),
}));

vi.mock("../../infra/task-lock.js", () => ({
  acquireTaskLock: vi.fn(async () => ({ release: vi.fn() })),
}));

vi.mock("../../infra/task-tracker.js", () => ({
  enableAgentManagedMode: vi.fn(),
  disableAgentManagedMode: vi.fn(),
}));

const mockEmit = vi.fn();
vi.mock("../../infra/events/bus.js", () => ({
  emit: (...args: unknown[]) => mockEmit(...args),
}));

const mockRetryAsync = vi.fn();
vi.mock("../../infra/retry.js", () => ({
  retryAsync: (...args: unknown[]) => mockRetryAsync(...args),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

// ─── C3: reassignCount roundtrip via mock ───

describe("C3 - reassignCount roundtrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.readdir as any).mockResolvedValue([]);
  });

  function makeBacklogTaskMd(
    taskId: string,
    opts: { reassignCount?: number; milestoneId?: string; milestoneItemId?: string } = {},
  ) {
    const backlogJson = JSON.stringify({
      createdBy: undefined,
      assignee: undefined,
      dependsOn: undefined,
      estimatedEffort: undefined,
      startDate: undefined,
      dueDate: undefined,
      milestoneId: opts.milestoneId,
      milestoneItemId: opts.milestoneItemId,
      reassignCount: opts.reassignCount,
    });
    return [
      "# Task: " + taskId,
      "",
      "## Metadata",
      "- **Status:** backlog",
      "- **Priority:** medium",
      "- **Created:** 2025-01-01T00:00:00.000Z",
      "",
      "## Description",
      "Test task",
      "",
      "## Progress",
      "",
      "## Last Activity",
      "2025-01-01T00:00:00.000Z",
      "",
      "## Backlog",
      "```json",
      backlogJson,
      "```",
      "",
      "---",
      "*Managed by task tools*",
    ].join("\n");
  }

  it("readTask returns reassignCount when set", async () => {
    const { readTask } = await import("./task-tool.js");
    (fs.readFile as any).mockResolvedValue(makeBacklogTaskMd("task_rc1", { reassignCount: 2 }));
    const task = await readTask("/workspace/main", "task_rc1");
    expect(task).not.toBeNull();
    expect(task!.reassignCount).toBe(2);
  });

  it("readTask returns undefined reassignCount when not in backlog section", async () => {
    const { readTask } = await import("./task-tool.js");
    const md = [
      "# Task: task_rc2",
      "",
      "## Metadata",
      "- **Status:** in_progress",
      "- **Priority:** medium",
      "- **Created:** 2025-01-01T00:00:00.000Z",
      "",
      "## Description",
      "No reassign",
      "",
      "## Progress",
      "",
      "## Last Activity",
      "2025-01-01T00:00:00.000Z",
      "",
      "---",
      "*Managed by task tools*",
    ].join("\n");
    (fs.readFile as any).mockResolvedValue(md);
    const task = await readTask("/workspace/main", "task_rc2");
    expect(task).not.toBeNull();
    expect(task!.reassignCount).toBeUndefined();
  });

  it("reassignCount=0 is preserved (not treated as falsy)", async () => {
    const { readTask } = await import("./task-tool.js");
    (fs.readFile as any).mockResolvedValue(makeBacklogTaskMd("task_rc3", { reassignCount: 0 }));
    const task = await readTask("/workspace/main", "task_rc3");
    expect(task).not.toBeNull();
    expect(task!.reassignCount).toBe(0);
  });

  it("milestoneId and milestoneItemId roundtrip", async () => {
    const { readTask } = await import("./task-tool.js");
    (fs.readFile as any).mockResolvedValue(
      makeBacklogTaskMd("task_rc4", {
        milestoneId: "ms_abc123",
        milestoneItemId: "item_xyz789",
        reassignCount: 1,
      }),
    );
    const task = await readTask("/workspace/main", "task_rc4");
    expect(task).not.toBeNull();
    expect(task!.milestoneId).toBe("ms_abc123");
    expect(task!.milestoneItemId).toBe("item_xyz789");
    expect(task!.reassignCount).toBe(1);
  });

  it("outcome field roundtrips through parse", async () => {
    const { readTask } = await import("./task-tool.js");
    const md = [
      "# Task: task_rc5",
      "",
      "## Metadata",
      "- **Status:** completed",
      "- **Priority:** medium",
      "- **Created:** 2025-01-01T00:00:00.000Z",
      "",
      "## Description",
      "Completed",
      "",
      "## Progress",
      "- done",
      "",
      "## Last Activity",
      "2025-01-01T00:00:00.000Z",
      "",
      "## Outcome",
      "```json",
      '{"kind":"completed","summary":"All good"}',
      "```",
      "",
      "---",
      "*Managed by task tools*",
    ].join("\n");
    (fs.readFile as any).mockResolvedValue(md);
    const task = await readTask("/workspace/main", "task_rc5");
    expect(task).not.toBeNull();
    expect(task!.outcome).toEqual({ kind: "completed", summary: "All good" });
  });
});

// ─── C2: Priority preservation in backlog_add ───

describe("C2 - priority preservation in backlog_add", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.readdir as any).mockResolvedValue([]);
  });

  it("backlog_add with priority=high creates high-priority task", async () => {
    const { createTaskBacklogAddTool } = await import("./task-tool.js");
    const tool = createTaskBacklogAddTool({ config: { agents: { list: [] } } as any });
    await tool!.execute("call-1", { description: "High prio task", priority: "high" });
    const writeCall = (fs.writeFile as any).mock.calls[0];
    expect(writeCall).toBeDefined();
    expect(writeCall[1]).toContain("**Priority:** high");
  });

  it("backlog_add with priority=urgent creates urgent task", async () => {
    const { createTaskBacklogAddTool } = await import("./task-tool.js");
    const tool = createTaskBacklogAddTool({ config: { agents: { list: [] } } as any });
    await tool!.execute("call-2", { description: "Urgent task", priority: "urgent" });
    expect((fs.writeFile as any).mock.calls[0][1]).toContain("**Priority:** urgent");
  });

  it("backlog_add defaults to medium when no priority given", async () => {
    const { createTaskBacklogAddTool } = await import("./task-tool.js");
    const tool = createTaskBacklogAddTool({ config: { agents: { list: [] } } as any });
    await tool!.execute("call-3", { description: "Default prio" });
    expect((fs.writeFile as any).mock.calls[0][1]).toContain("**Priority:** medium");
  });

  it("backlog_add with invalid priority defaults to medium", async () => {
    const { createTaskBacklogAddTool } = await import("./task-tool.js");
    const tool = createTaskBacklogAddTool({ config: { agents: { list: [] } } as any });
    await tool!.execute("call-4", { description: "Bad prio", priority: "super_duper" });
    expect((fs.writeFile as any).mock.calls[0][1]).toContain("**Priority:** medium");
  });
});

// ─── C1: Milestone retry + MILESTONE_SYNC_FAILED ───

describe("C1 - milestone retry + MILESTONE_SYNC_FAILED", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.readdir as any).mockResolvedValue([]);
  });

  function makeInProgressMd(taskId: string, milestoneId?: string, milestoneItemId?: string) {
    const lines = [
      "# Task: " + taskId,
      "",
      "## Metadata",
      "- **Status:** in_progress",
      "- **Priority:** medium",
      "- **Created:** 2025-01-01T00:00:00.000Z",
      "",
      "## Description",
      "Milestone task",
      "",
      "## Progress",
      "- started",
      "",
      "## Last Activity",
      "2025-01-01T00:00:00.000Z",
      "",
    ];
    if (milestoneId) {
      lines.push(
        "## Backlog",
        "```json",
        JSON.stringify({ milestoneId, milestoneItemId }),
        "```",
        "",
      );
    }
    lines.push("---", "*Managed by task tools*");
    return lines.join("\n");
  }

  it("task_complete calls retryAsync for milestone sync", async () => {
    const { createTaskCompleteTool } = await import("./task-tool.js");
    const tool = createTaskCompleteTool({ config: { agents: { list: [] } } as any });
    (fs.readFile as any).mockResolvedValue(makeInProgressMd("task_ms1", "ms-1", "item-1"));
    (fs.readdir as any).mockResolvedValue(["task_ms1.md"]);
    mockRetryAsync.mockResolvedValue(undefined);
    await tool!.execute("call-ms1", { task_id: "task_ms1", summary: "done" });
    expect(mockRetryAsync).toHaveBeenCalled();
  });

  it("task_complete emits MILESTONE_SYNC_FAILED on failure", async () => {
    const { createTaskCompleteTool } = await import("./task-tool.js");
    const tool = createTaskCompleteTool({ config: { agents: { list: [] } } as any });
    (fs.readFile as any).mockResolvedValue(makeInProgressMd("task_ms2", "ms-2", "item-2"));
    (fs.readdir as any).mockResolvedValue(["task_ms2.md"]);
    mockRetryAsync.mockRejectedValue(new Error("sync failed"));
    await tool!.execute("call-ms2", { task_id: "task_ms2" });
    const found = mockEmit.mock.calls.find(
      (c: unknown[]) => (c[0] as any).type === "milestone.sync_failed",
    );
    expect(found).toBeDefined();
  });

  it("task_complete succeeds even when milestone sync fails", async () => {
    const { createTaskCompleteTool } = await import("./task-tool.js");
    const tool = createTaskCompleteTool({ config: { agents: { list: [] } } as any });
    (fs.readFile as any).mockResolvedValue(makeInProgressMd("task_ms3", "ms-3", "item-3"));
    (fs.readdir as any).mockResolvedValue(["task_ms3.md"]);
    mockRetryAsync.mockRejectedValue(new Error("fail"));
    const result = await tool!.execute("call-ms3", { task_id: "task_ms3" });
    expect(JSON.parse(result.content[0].text).success).toBe(true);
  });

  it("task_complete does not sync when no milestoneId", async () => {
    const { createTaskCompleteTool } = await import("./task-tool.js");
    const tool = createTaskCompleteTool({ config: { agents: { list: [] } } as any });
    (fs.readFile as any).mockResolvedValue(makeInProgressMd("task_ms4"));
    (fs.readdir as any).mockResolvedValue(["task_ms4.md"]);
    await tool!.execute("call-ms4", { task_id: "task_ms4" });
    expect(mockRetryAsync).not.toHaveBeenCalled();
  });
});

// ─── M7: scope=all aggregation ───

describe("M7 - scope=all aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeSimpleMd(taskId: string, status: string, priority: string, desc: string) {
    return [
      "# Task: " + taskId,
      "",
      "## Metadata",
      "- **Status:** " + status,
      "- **Priority:** " + priority,
      "- **Created:** 2025-01-01T00:00:00.000Z",
      "",
      "## Description",
      desc,
      "",
      "## Progress",
      "",
      "## Last Activity",
      "2025-01-01T00:00:00.000Z",
      "",
      "---",
      "*Managed by task tools*",
    ].join("\n");
  }

  it("task_list scope=all aggregates from all agents", async () => {
    const { createTaskListTool } = await import("./task-tool.js");
    const tool = createTaskListTool({ config: { agents: { list: [{ id: "agent1" }] } } as any });
    (fs.readdir as any).mockImplementation(async (dir: string) => {
      if (String(dir).includes("main")) {
        return ["task_a1.md"];
      }
      if (String(dir).includes("agent1")) {
        return ["task_b1.md"];
      }
      return [];
    });
    (fs.readFile as any).mockImplementation(async (fp: string) => {
      if (String(fp).includes("task_a1")) {
        return makeSimpleMd("task_a1", "in_progress", "high", "Main");
      }
      if (String(fp).includes("task_b1")) {
        return makeSimpleMd("task_b1", "pending", "medium", "Agent1");
      }
      return "";
    });
    const result = await tool!.execute("call-1", { scope: "all" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.scope).toBe("all");
    expect(parsed.count).toBe(2);
  });

  it("task_list scope=all includes agentId per task", async () => {
    const { createTaskListTool } = await import("./task-tool.js");
    const tool = createTaskListTool({ config: { agents: { list: [{ id: "agent1" }] } } as any });
    (fs.readdir as any).mockImplementation(async (dir: string) => {
      if (String(dir).includes("main")) {
        return ["task_x1.md"];
      }
      return [];
    });
    (fs.readFile as any).mockResolvedValue(makeSimpleMd("task_x1", "in_progress", "medium", "X"));
    const result = await tool!.execute("call-2", { scope: "all" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tasks.length).toBeGreaterThan(0);
    expect(parsed.tasks[0].agentId).toBeDefined();
  });

  it("task_list scope=all with status filter", async () => {
    const { createTaskListTool } = await import("./task-tool.js");
    const tool = createTaskListTool({ config: { agents: { list: [{ id: "agent1" }] } } as any });
    (fs.readdir as any).mockImplementation(async (dir: string) => {
      if (String(dir).includes("main")) {
        return ["task_f1.md", "task_f2.md"];
      }
      return [];
    });
    (fs.readFile as any).mockImplementation(async (fp: string) => {
      if (String(fp).includes("task_f1")) {
        return makeSimpleMd("task_f1", "in_progress", "high", "Active");
      }
      if (String(fp).includes("task_f2")) {
        return makeSimpleMd("task_f2", "pending", "low", "Pending");
      }
      return "";
    });
    const result = await tool!.execute("call-3", { scope: "all", status: "in_progress" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tasks.every((t: any) => t.status === "in_progress")).toBe(true);
  });
});
