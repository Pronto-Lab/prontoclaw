import { describe, expect, it } from "vitest";

describe("task-monitor-server", () => {
  describe("parseTaskFileMd", () => {
    it("parses valid task file content", () => {
      const content = `# Task: task_abc123

## Metadata
- **Status:** in_progress
- **Priority:** high
- **Created:** 2026-02-04T12:00:00.000Z

## Description
Test task description

## Progress
- Task started
- Step 1 done

## Last Activity
2026-02-04T12:30:00.000Z

---
*Managed by task tools*`;

      const result = parseTaskFileMd(content, "task_abc123.md");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("task_abc123");
      expect(result!.status).toBe("in_progress");
      expect(result!.priority).toBe("high");
      expect(result!.description).toBe("Test task description");
      expect(result!.progress).toEqual(["Task started", "Step 1 done"]);
    });

    it("returns null for empty task marker", () => {
      const content = "*(No task)*";
      const result = parseTaskFileMd(content, "task_abc.md");
      expect(result).toBeNull();
    });

    it("returns null for empty content", () => {
      const result = parseTaskFileMd("", "task_abc.md");
      expect(result).toBeNull();
    });

    it("handles missing optional fields", () => {
      const content = `# Task: task_minimal

## Metadata
- **Status:** pending
- **Priority:** medium
- **Created:** 2026-02-04T12:00:00.000Z

## Description
Minimal task

## Progress

## Last Activity
2026-02-04T12:00:00.000Z`;

      const result = parseTaskFileMd(content, "task_minimal.md");

      expect(result).not.toBeNull();
      expect(result!.context).toBeUndefined();
      expect(result!.source).toBeUndefined();
      expect(result!.progress).toEqual([]);
    });

    it("parses abandoned task status correctly", () => {
      const content = `# Task: task_abandoned1

## Metadata
- **Status:** abandoned
- **Priority:** medium
- **Created:** 2026-02-03T10:00:00Z

## Description
A zombie task that was auto-abandoned

## Progress
- Started working
- Auto-abandoned: no activity for 24h (TTL: 24h)

## Last Activity
2026-02-05T10:00:00Z

---
*Managed by task tools*`;

      const result = parseTaskFileMd(content, "task_abandoned1.md");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("task_abandoned1");
      expect(result!.status).toBe("abandoned");
      expect(result!.priority).toBe("medium");
      expect(result!.description).toBe("A zombie task that was auto-abandoned");
      expect(result!.progress).toEqual([
        "Started working",
        "Auto-abandoned: no activity for 24h (TTL: 24h)",
      ]);
      expect(result!.lastActivity).toBe("2026-02-05T10:00:00Z");
    });

    it("parses Steps section from task file", () => {
      const content = `# Task: task_steps_test

## Metadata
- **Status:** in_progress
- **Priority:** high
- **Created:** 2026-02-13T12:00:00.000Z

## Description
OAuth login implementation

## Steps
- [x] (s1) Analyze existing auth structure
- [>] (s2) Add Google OAuth strategy
- [ ] (s3) Implement GitHub OAuth callback
- [-] (s4) Skipped step

## Progress
- Task started
- [s1] Auth analysis complete

## Last Activity
2026-02-13T12:30:00.000Z`;

      const result = parseTaskFileMd(content, "task_steps_test.md");

      expect(result).not.toBeNull();
      expect(result!.steps).toHaveLength(4);
      expect(result!.steps![0]).toEqual({
        id: "s1",
        content: "Analyze existing auth structure",
        status: "done",
        order: 1,
      });
      expect(result!.steps![1]).toEqual({
        id: "s2",
        content: "Add Google OAuth strategy",
        status: "in_progress",
        order: 2,
      });
      expect(result!.steps![2]).toEqual({
        id: "s3",
        content: "Implement GitHub OAuth callback",
        status: "pending",
        order: 3,
      });
      expect(result!.steps![3]).toEqual({
        id: "s4",
        content: "Skipped step",
        status: "skipped",
        order: 4,
      });
      expect(result!.stepsProgress).toEqual({
        total: 4,
        done: 1,
        inProgress: 1,
        pending: 1,
        skipped: 1,
      });
    });

    it("returns undefined steps for task without Steps section", () => {
      const content = `# Task: task_no_steps

## Metadata
- **Status:** in_progress
- **Priority:** medium
- **Created:** 2026-02-13T12:00:00.000Z

## Description
Simple task without steps

## Progress
- Task started

## Last Activity
2026-02-13T12:00:00.000Z`;

      const result = parseTaskFileMd(content, "task_no_steps.md");

      expect(result).not.toBeNull();
      expect(result!.steps).toBeUndefined();
      expect(result!.stepsProgress).toBeUndefined();
    });
  });

  describe("priority sorting", () => {
    it("sorts tasks by priority (urgent > high > medium > low)", () => {
      const mockTasks = [
        { priority: "low", created: "2026-02-04T10:00:00Z" },
        { priority: "urgent", created: "2026-02-04T11:00:00Z" },
        { priority: "high", created: "2026-02-04T12:00:00Z" },
        { priority: "medium", created: "2026-02-04T13:00:00Z" },
      ];

      const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
      const sorted = mockTasks.toSorted((a, b) => {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });

      expect(sorted[0].priority).toBe("urgent");
      expect(sorted[1].priority).toBe("high");
      expect(sorted[2].priority).toBe("medium");
      expect(sorted[3].priority).toBe("low");
    });
  });

  describe("API structure validation", () => {
    it("agent info has required fields", () => {
      const agentInfo = {
        id: "main",
        workspaceDir: "/path/to/workspace",
        hasCurrentTask: false,
        taskCount: 0,
      };

      expect(agentInfo).toHaveProperty("id");
      expect(agentInfo).toHaveProperty("workspaceDir");
      expect(agentInfo).toHaveProperty("hasCurrentTask");
      expect(agentInfo).toHaveProperty("taskCount");
    });

    it("WebSocket message has required fields", () => {
      const wsMessage = {
        type: "task_update" as const,
        agentId: "main",
        taskId: "task_abc123",
        timestamp: new Date().toISOString(),
        data: { event: "change", file: "task_abc123.md" },
      };

      expect(wsMessage).toHaveProperty("type");
      expect(wsMessage).toHaveProperty("timestamp");
      expect(["agent_update", "task_update", "task_step_update", "connected"]).toContain(
        wsMessage.type,
      );
    });
  });
});

type TaskStatus =
  | "pending"
  | "pending_approval"
  | "in_progress"
  | "blocked"
  | "completed"
  | "cancelled"
  | "abandoned";
type TaskPriority = "low" | "medium" | "high" | "urgent";

type MonitorTaskStep = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "done" | "skipped";
  order: number;
};

interface TaskFile {
  id: string;
  status: TaskStatus;
  priority: TaskPriority;
  description: string;
  context?: string;
  source?: string;
  created: string;
  lastActivity: string;
  progress: string[];
  steps?: MonitorTaskStep[];
  stepsProgress?: {
    total: number;
    done: number;
    inProgress: number;
    pending: number;
    skipped: number;
  };
}

function parseTaskFileMd(content: string, filename: string): TaskFile | null {
  if (!content || content.includes("*(No task)*")) {
    return null;
  }

  const idMatch = filename.match(/^(task_[a-z0-9_]+)\.md$/);
  const id = idMatch ? idMatch[1] : filename.replace(".md", "");

  const lines = content.split("\n");
  let status: TaskStatus = "pending";
  let priority: TaskPriority = "medium";
  let description = "";
  let context: string | undefined;
  let source: string | undefined;
  let created = "";
  let lastActivity = "";
  const progress: string[] = [];
  const steps: MonitorTaskStep[] = [];

  let currentSection = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("## ")) {
      currentSection = trimmed.slice(3).toLowerCase();
      continue;
    }

    if (trimmed.startsWith("# Task:")) {
      continue;
    }

    if (trimmed.startsWith("---") || trimmed.startsWith("*Managed by")) {
      continue;
    }

    if (!trimmed) {
      continue;
    }

    if (currentSection === "metadata") {
      const statusMatch = trimmed.match(/^-?\s*\*\*Status:\*\*\s*(.+)$/);
      if (statusMatch) {
        status = statusMatch[1] as TaskStatus;
      }
      const priorityMatch = trimmed.match(/^-?\s*\*\*Priority:\*\*\s*(.+)$/);
      if (priorityMatch) {
        priority = priorityMatch[1] as TaskPriority;
      }
      const createdMatch = trimmed.match(/^-?\s*\*\*Created:\*\*\s*(.+)$/);
      if (createdMatch) {
        created = createdMatch[1];
      }
      const sourceMatch = trimmed.match(/^-?\s*\*\*Source:\*\*\s*(.+)$/);
      if (sourceMatch) {
        source = sourceMatch[1];
      }
    } else if (currentSection === "description") {
      description = trimmed;
    } else if (currentSection === "context") {
      context = trimmed;
    } else if (currentSection === "last activity") {
      lastActivity = trimmed;
    } else if (currentSection === "progress") {
      if (trimmed.startsWith("- ")) {
        progress.push(trimmed.slice(2));
      }
    } else if (currentSection === "steps") {
      const stepMatch = trimmed.match(/^- \[([x> -])\] \((\w+)\) (.+)$/);
      if (stepMatch) {
        const statusMap: Record<string, MonitorTaskStep["status"]> = {
          x: "done",
          ">": "in_progress",
          " ": "pending",
          "-": "skipped",
        };
        steps.push({
          id: stepMatch[2],
          content: stepMatch[3],
          status: statusMap[stepMatch[1]] || "pending",
          order: steps.length + 1,
        });
      }
    }
  }

  return {
    id,
    status,
    priority,
    description: description || "(no description)",
    context,
    source,
    created: created || new Date().toISOString(),
    lastActivity: lastActivity || created || new Date().toISOString(),
    progress,
    steps: steps.length > 0 ? steps : undefined,
    stepsProgress:
      steps.length > 0
        ? {
            total: steps.length,
            done: steps.filter((s) => s.status === "done").length,
            inProgress: steps.filter((s) => s.status === "in_progress").length,
            pending: steps.filter((s) => s.status === "pending").length,
            skipped: steps.filter((s) => s.status === "skipped").length,
          }
        : undefined,
  };
}
