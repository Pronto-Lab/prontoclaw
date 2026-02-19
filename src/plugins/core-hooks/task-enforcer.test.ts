import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    readdir: vi.fn(),
    readFile: vi.fn(),
  },
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { workspace: "/workspace" } },
  })),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/workspace/main"),
}));

import {
  taskEnforcerHandler,
  clearTaskEnforcerState,
  hasActiveTask,
  markTaskStarted,
} from "./task-enforcer.js";
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext } from "../types.js";

describe("task-enforcer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTaskEnforcerState();
  });

  afterEach(() => {
    clearTaskEnforcerState();
  });

  const createEvent = (toolName: string): PluginHookBeforeToolCallEvent => ({
    toolName,
    parameters: {},
  });

  const createContext = (agentId = "main"): PluginHookToolContext => ({
    agentId,
    sessionKey: "test-session",
  } as PluginHookToolContext);

  describe("exempt tools", () => {
    it.each([
      "task_start",
      "task_complete",
      "task_update",
      "task_list",
      "task_status",
      "read",
      "glob",
      "grep",
    ])("allows %s without task_start", async (toolName) => {
      const result = await taskEnforcerHandler(createEvent(toolName), createContext());
      expect(result?.block).not.toBe(true);
    });
  });

  describe("enforced tools", () => {
    it.each(["write", "edit", "bash", "exec"])(
      "blocks %s without task_start",
      async (toolName) => {
        vi.mocked(fs.readdir).mockResolvedValue([]);
        const result = await taskEnforcerHandler(createEvent(toolName), createContext());
        expect(result?.block).toBe(true);
        expect(result?.blockReason).toContain("TASK TRACKING REQUIRED");
      }
    );

    it("allows enforced tools after task_start", async () => {
      const ctx = createContext();

      // Call task_start first
      await taskEnforcerHandler(createEvent("task_start"), ctx);

      // Now write should be allowed
      const result = await taskEnforcerHandler(createEvent("write"), ctx);
      expect(result?.block).not.toBe(true);
    });
  });

  describe("disk recovery", () => {
    it("recovers state from disk when task file matches session", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      // Task file has matching session key
      vi.mocked(fs.readFile).mockResolvedValue(
        "- **Status:** in_progress\n- **Created By Session:** test-session"
      );

      const result = await taskEnforcerHandler(createEvent("write"), createContext());

      // Should allow because recovered from disk with matching session
      expect(result?.block).not.toBe(true);
    });

    it("blocks when task file exists but from different session", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      // Task file has DIFFERENT session key
      vi.mocked(fs.readFile).mockResolvedValue(
        "- **Status:** in_progress\n- **Created By Session:** old-session"
      );

      const result = await taskEnforcerHandler(createEvent("write"), createContext());
      expect(result?.block).toBe(true);
    });

    it("blocks when task file has no session metadata", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc123.md"] as never);
      // Legacy task file without session metadata
      vi.mocked(fs.readFile).mockResolvedValue("- **Status:** in_progress");

      const result = await taskEnforcerHandler(createEvent("write"), createContext());
      // Should block — legacy files without session metadata don't bypass
      expect(result?.block).toBe(true);
    });

    it("blocks when no task files on disk", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const result = await taskEnforcerHandler(createEvent("write"), createContext());
      expect(result?.block).toBe(true);
    });
  });

  describe("session state", () => {
    it("markTaskStarted sets session state", () => {
      expect(hasActiveTask("main")).toBe(false);
      markTaskStarted("main");
      expect(hasActiveTask("main")).toBe(true);
    });

    it("clearTaskEnforcerState clears all state", () => {
      markTaskStarted("main");
      markTaskStarted("agent1");

      clearTaskEnforcerState();

      expect(hasActiveTask("main")).toBe(false);
      expect(hasActiveTask("agent1")).toBe(false);
    });

    it("tracks separate sessions per agent", () => {
      markTaskStarted("main", "session1");

      expect(hasActiveTask("main", "session1")).toBe(true);
      expect(hasActiveTask("main", "session2")).toBe(false);
    });
  });
});
