import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn((_cfg, _agentId) => "/workspace/main"),
  resolveSessionAgentId: vi.fn(() => "main"),
  listAgentIds: vi.fn(() => ["main", "agent1", "agent2"]),
}));

vi.mock("../../infra/task-tracker.js", () => ({
  enableAgentManagedMode: vi.fn(),
  disableAgentManagedMode: vi.fn(),
}));

import {
  createTaskApproveTool,
  createTaskBlockTool,
  createTaskCancelTool,
  createTaskCompleteTool,
  createTaskListTool,
  createTaskStartTool,
  createTaskStatusTool,
  createTaskUpdateTool,
} from "./task-tool.js";

const mockConfig = { agents: { defaults: { workspace: "/workspace" } } } as never;

describe("task-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createTaskStartTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskStartTool({});
      expect(tool).toBeNull();
    });

    it("creates a tool with correct metadata", () => {
      const tool = createTaskStartTool({ config: mockConfig });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("task_start");
      expect(tool!.label).toBe("Task Start");
    });

    it("creates task with default priority", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { description: "Test task" });

      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.priority).toBe("medium");
      expect(parsed.taskId).toMatch(/^task_/);
    });

    it("respects custom priority", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Urgent task",
        priority: "urgent",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.priority).toBe("urgent");
    });

    it("includes context when provided", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      await tool!.execute("call-1", {
        description: "Task with context",
        context: "User requested via Discord",
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const content = writeCall[1] as string;
      expect(content).toContain("## Context");
      expect(content).toContain("User requested via Discord");
    });
  });

  describe("createTaskUpdateTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskUpdateTool({});
      expect(tool).toBeNull();
    });

    it("creates a tool with correct metadata", () => {
      const tool = createTaskUpdateTool({ config: mockConfig });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("task_update");
    });

    it("returns error when no active task and no task_id", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      const tool = createTaskUpdateTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { progress: "Working on it" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("No active task");
    });

    it("updates task with progress entry", async () => {
      const existingTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockResolvedValue(existingTask);

      const tool = createTaskUpdateTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { progress: "Added new feature" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.progressCount).toBe(2);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("task_abc123.md"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;
      expect(content).toContain("Added new feature");
    });
  });

  describe("createTaskCompleteTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskCompleteTool({});
      expect(tool).toBeNull();
    });

    it("archives task to monthly history file", async () => {
      const existingTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task-history")) {
          throw new Error("File not found");
        }
        return existingTask;
      });

      const tool = createTaskCompleteTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.archived).toBe(true);
      expect(parsed.archivedTo as string).toMatch(/^task-history\/\d{4}-\d{2}\.md$/);
      expect(fs.unlink).toHaveBeenCalled();
    });

    it("includes summary in history when provided", async () => {
      const existingTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task-history")) {
          return "# Task History - February 2026\n";
        }
        return existingTask;
      });

      const tool = createTaskCompleteTool({ config: mockConfig });
      await tool!.execute("call-1", { summary: "Successfully implemented feature" });

      const historyWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("task-history/"));
      expect(historyWrite).toBeDefined();
      const content = historyWrite![1] as string;
      expect(content).toContain("Successfully implemented feature");
    });
  });

  describe("createTaskStatusTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskStatusTool({});
      expect(tool).toBeNull();
    });

    it("returns summary when no task_id provided", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      const tool = createTaskStatusTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.totalTasks).toBe(0);
      expect(parsed.byStatus).toBeDefined();
    });

    it("returns specific task when task_id provided", async () => {
      const existingTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** high
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Important task

## Progress
- Task started
- Working on it

## Last Activity
2026-02-04T11:30:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(existingTask);

      const tool = createTaskStatusTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_abc123" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.found).toBe(true);
      expect(parsed.task.id).toBe("task_abc123");
      expect(parsed.task.priority).toBe("high");
      expect(parsed.task.progressCount).toBe(2);
    });
  });

  describe("createTaskListTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskListTool({});
      expect(tool).toBeNull();
    });

    it("returns empty list when no tasks", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      const tool = createTaskListTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.count).toBe(0);
      expect(parsed.tasks).toEqual([]);
    });

    it("filters by status", async () => {
      const inProgressTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Task 1

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      const pendingTask = `# Task: task_def456

## Metadata
- **Status:** pending
- **Priority:** low
- **Created:** 2026-02-04T10:00:00.000Z

## Description
Task 2

## Progress
- Task started

## Last Activity
2026-02-04T10:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md", "task_def456.md"] as never);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_abc123")) {
          return inProgressTask;
        }
        if ((filePath as string).includes("task_def456")) {
          return pendingTask;
        }
        throw new Error("Not found");
      });

      const tool = createTaskListTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { status: "in_progress" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.count).toBe(1);
      expect(parsed.tasks[0].id).toBe("task_abc123");
    });
  });

  describe("createTaskCancelTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskCancelTool({});
      expect(tool).toBeNull();
    });

    it("cancels task with reason", async () => {
      const existingTask = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Test task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_abc123")) {
          return existingTask;
        }
        if ((filePath as string).includes("TASK_HISTORY")) {
          throw new Error("Not found");
        }
        throw new Error("Not found");
      });

      const tool = createTaskCancelTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        task_id: "task_abc123",
        reason: "No longer needed",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.cancelled).toBe(true);
      expect(parsed.reason).toBe("No longer needed");
    });

    it("returns error for non-existent task", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("Not found"));

      const tool = createTaskCancelTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_nonexistent" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("not found");
    });
  });

  describe("task file format", () => {
    it("generates valid markdown format", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      await tool!.execute("call-1", {
        description: "Test task description",
        context: "Test context",
        priority: "high",
      });

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("tasks/task_"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

      expect(content).toContain("# Task:");
      expect(content).toContain("## Metadata");
      expect(content).toContain("- **Status:** in_progress");
      expect(content).toContain("- **Priority:** high");
      expect(content).toContain("## Description");
      expect(content).toContain("Test task description");
      expect(content).toContain("## Context");
      expect(content).toContain("Test context");
      expect(content).toContain("## Progress");
      expect(content).toContain("- Task started");
      expect(content).toContain("*Managed by task tools*");
    });
  });

  describe("priority sorting", () => {
    it("sorts tasks by priority then creation time", async () => {
      const urgentTask = `# Task: task_urgent

## Metadata
- **Status:** in_progress
- **Priority:** urgent
- **Created:** 2026-02-04T12:00:00.000Z

## Description
Urgent task

## Progress
- Task started

## Last Activity
2026-02-04T12:00:00.000Z

---
*Managed by task tools*`;

      const lowTask = `# Task: task_low

## Metadata
- **Status:** in_progress
- **Priority:** low
- **Created:** 2026-02-04T10:00:00.000Z

## Description
Low priority task

## Progress
- Task started

## Last Activity
2026-02-04T10:00:00.000Z

---
*Managed by task tools*`;

      const highTask = `# Task: task_high

## Metadata
- **Status:** in_progress
- **Priority:** high
- **Created:** 2026-02-04T11:00:00.000Z

## Description
High priority task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue([
        "task_low.md",
        "task_urgent.md",
        "task_high.md",
      ] as never);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_urgent")) {
          return urgentTask;
        }
        if ((filePath as string).includes("task_low")) {
          return lowTask;
        }
        if ((filePath as string).includes("task_high")) {
          return highTask;
        }
        throw new Error("Not found");
      });

      const tool = createTaskListTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {});

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.tasks[0].id).toBe("task_urgent");
      expect(parsed.tasks[1].id).toBe("task_high");
      expect(parsed.tasks[2].id).toBe("task_low");
    });
  });

  describe("createTaskStartTool with requires_approval", () => {
    it("creates task with pending_approval status when requires_approval is true", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Task needing approval",
        requires_approval: true,
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.status).toBe("pending_approval");
      expect(parsed.requiresApproval).toBe(true);
      expect(parsed.started).toBeNull();

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("tasks/task_"));
      const content = writeCall![1] as string;
      expect(content).toContain("- **Status:** pending_approval");
      expect(content).toContain("- Task created - awaiting approval");
    });

    it("creates task with in_progress status when requires_approval is false", async () => {
      const tool = createTaskStartTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        description: "Regular task",
        requires_approval: false,
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.status).toBe("in_progress");
      expect(parsed.requiresApproval).toBe(false);
    });
  });

  describe("createTaskApproveTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskApproveTool({});
      expect(tool).toBeNull();
    });

    it("approves pending_approval task and transitions to in_progress", async () => {
      const pendingApprovalTask = `# Task: task_pending123

## Metadata
- **Status:** pending_approval
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Task awaiting approval

## Progress
- Task created - awaiting approval

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("task_pending123")) {
          return pendingApprovalTask;
        }
        throw new Error("Not found");
      });

      const tool = createTaskApproveTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_pending123" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.approved).toBe(true);
      expect(parsed.taskId).toBe("task_pending123");

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("task_pending123"));
      const content = writeCall![1] as string;
      expect(content).toContain("- **Status:** in_progress");
      expect(content).toContain("- Task approved and started");
    });

    it("returns error when task is not pending_approval", async () => {
      const inProgressTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(inProgressTask);

      const tool = createTaskApproveTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_active123" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("not pending approval");
    });

    it("returns error for non-existent task", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("Not found"));

      const tool = createTaskApproveTool({ config: mockConfig });
      const result = await tool!.execute("call-1", { task_id: "task_nonexistent" });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("not found");
    });
  });

  describe("createTaskBlockTool", () => {
    it("returns null when config is missing", () => {
      const tool = createTaskBlockTool({});
      expect(tool).toBeNull();
    });

    it("rejects non-existent agent ID in unblock_by", async () => {
      const activeTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(activeTask);

      const tool = createTaskBlockTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        task_id: "task_active123",
        reason: "Waiting for external API",
        unblock_by: ["invalid_agent"],
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Invalid agent ID");
      expect(parsed.error).toContain("invalid_agent");
      expect(parsed.error).toContain("Valid agents");
    });

    it("rejects self-reference (agent blocking with itself as unblocker)", async () => {
      const activeTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(activeTask);

      const tool = createTaskBlockTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        task_id: "task_active123",
        reason: "Waiting for something",
        unblock_by: ["main"],
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Agent cannot unblock itself");
      expect(parsed.error).toContain("main");
    });

    it("accepts valid agent IDs", async () => {
      const activeTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(activeTask);

      const tool = createTaskBlockTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        task_id: "task_active123",
        reason: "Waiting for agent1 to complete their task",
        unblock_by: ["agent1", "agent2"],
        unblock_action: "notify_agents",
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.status).toBe("blocked");
      expect(parsed.blockedReason).toBe("Waiting for agent1 to complete their task");
      expect(parsed.unblockedBy).toEqual(["agent1", "agent2"]);
      expect(parsed.unblockedAction).toBe("notify_agents");

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes("task_active123"));
      const content = writeCall![1] as string;
      expect(content).toContain("- **Status:** blocked");
      expect(content).toContain("[BLOCKED] Waiting for agent1 to complete their task");
    });

    it("returns clear error message with invalid ID listed", async () => {
      const activeTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readFile).mockResolvedValue(activeTask);

      const tool = createTaskBlockTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        task_id: "task_active123",
        reason: "Waiting for help",
        unblock_by: ["agent1", "nonexistent_agent", "another_invalid"],
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("nonexistent_agent");
      expect(parsed.error).toContain("another_invalid");
      expect(parsed.error).toContain("Valid agents");
      expect(parsed.error).toContain("main");
      expect(parsed.error).toContain("agent1");
      expect(parsed.error).toContain("agent2");
    });

    it("blocks current task when task_id is not specified", async () => {
      const currentTaskPointer = "task_active123";
      const activeTask = `# Task: task_active123

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-04T11:00:00.000Z

## Description
Active task

## Progress
- Task started

## Last Activity
2026-02-04T11:00:00.000Z

---
*Managed by task tools*`;

      vi.mocked(fs.readdir).mockResolvedValue(["task_active123.md"]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if ((filePath as string).includes("CURRENT_TASK")) {
          return currentTaskPointer;
        }
        if ((filePath as string).includes("task_active123")) {
          return activeTask;
        }
        throw new Error("Not found");
      });

      const tool = createTaskBlockTool({ config: mockConfig });
      const result = await tool!.execute("call-1", {
        reason: "Waiting for external service",
        unblock_by: ["agent1"],
      });

      const parsed = result.details as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.status).toBe("blocked");
      expect(parsed.taskId).toBe("task_active123");
    });
  });
});
