import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn().mockReturnValue(["main", "eden", "seum"]),
  resolveAgentWorkspaceDir: vi.fn((cfg, agentId) => `/workspace/${agentId}`),
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: vi.fn(() => "/tmp/test-state"),
}));

vi.mock("../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../routing/session-key.js", () => ({
  buildAgentMainSessionKey: vi.fn(({ agentId }) => `agent:${agentId}:main`),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {},
}));

import fs from "node:fs/promises";
import { listAgentIds } from "../agents/agent-scope.js";
import { agentCommand } from "../commands/agent.js";

describe("task-continuation", () => {
  describe("parseCurrentTaskMd", () => {
    it("returns null when no Current section exists", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      vi.mocked(fs.readFile).mockResolvedValue("# Other Content\n\nNo current section here.");
      vi.mocked(listAgentIds).mockReturnValue(["main"]);

      const tasks = await loadPendingTasks({} as never);

      expect(tasks).toHaveLength(0);
    });

    it("returns null when section contains Korean empty marker", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      const content = `# Current Task

## Current

*(진행 중인 작업 없음)*

---`;
      vi.mocked(fs.readFile).mockResolvedValue(content);
      vi.mocked(listAgentIds).mockReturnValue(["main"]);

      const tasks = await loadPendingTasks({} as never);

      expect(tasks).toHaveLength(0);
    });

    it("returns null when section contains English empty marker", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      const content = `# Current Task

## Current

*(No task in progress)*

---`;
      vi.mocked(fs.readFile).mockResolvedValue(content);
      vi.mocked(listAgentIds).mockReturnValue(["main"]);

      const tasks = await loadPendingTasks({} as never);

      expect(tasks).toHaveLength(0);
    });

    it("parses content with all fields", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      const content = `# Current Task

## Current

**Task:** Implement feature X
**Thread ID:** 12345
**Context:** User requested new button
**Next:** Add CSS styling
**Progress:**
- [x] Create component
- [ ] Add tests

---`;
      vi.mocked(fs.readFile).mockResolvedValue(content);
      vi.mocked(listAgentIds).mockReturnValue(["main"]);

      const tasks = await loadPendingTasks({} as never);

      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        agentId: "main",
        task: "Implement feature X",
        threadId: "12345",
        context: "User requested new button",
        next: "Add CSS styling",
      });
      expect(tasks[0].progress).toContain("Create component");
      expect(tasks[0].progress).toContain("Add tests");
    });

    it("parses content with minimal fields", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      const content = `# Current Task

## Current

**Task:** Simple task

---`;
      vi.mocked(fs.readFile).mockResolvedValue(content);
      vi.mocked(listAgentIds).mockReturnValue(["eden"]);

      const tasks = await loadPendingTasks({} as never);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].agentId).toBe("eden");
      expect(tasks[0].task).toBe("Simple task");
    });
  });

  describe("loadPendingTasks", () => {
    it("returns empty array when no agents have tasks", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(listAgentIds).mockReturnValue(["main", "eden"]);

      const tasks = await loadPendingTasks({} as never);

      expect(tasks).toHaveLength(0);
    });

    it("returns tasks for multiple agents", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      vi.mocked(listAgentIds).mockReturnValue(["main", "eden"]);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(`## Current\n\n**Task:** Main task`)
        .mockResolvedValueOnce(`## Current\n\n**Task:** Eden task`);

      const tasks = await loadPendingTasks({} as never);

      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.agentId)).toEqual(["main", "eden"]);
    });

    it("skips agents with missing task files", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      vi.mocked(listAgentIds).mockReturnValue(["main", "eden", "seum"]);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(`## Current\n\n**Task:** Main task`)
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce(`## Current\n\n**Task:** Seum task`);

      const tasks = await loadPendingTasks({} as never);

      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.agentId)).toEqual(["main", "seum"]);
    });
  });

  describe("resumePendingTasks", () => {
    it("calls agentCommand for each pending task", async () => {
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce('{"version":1,"lastResumeAt":0}')
        .mockResolvedValueOnce(`## Current\n\n**Task:** Test task`);

      vi.mocked(listAgentIds).mockReturnValue(["main"]);

      const { resumePendingTasks } = await import("./task-continuation.js");

      const result = await resumePendingTasks({
        cfg: {} as never,
        deps: {} as never,
      });

      expect(agentCommand).toHaveBeenCalled();
      expect(result.resumed).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it("returns correct counts on failure", async () => {
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce('{"version":1,"lastResumeAt":0}')
        .mockResolvedValueOnce(`## Current\n\n**Task:** Test task`);

      vi.mocked(listAgentIds).mockReturnValue(["main"]);
      vi.mocked(agentCommand).mockRejectedValueOnce(new Error("Failed"));

      const { resumePendingTasks } = await import("./task-continuation.js");

      const result = await resumePendingTasks({
        cfg: {} as never,
        deps: {} as never,
      });

      expect(result.resumed).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });
});
