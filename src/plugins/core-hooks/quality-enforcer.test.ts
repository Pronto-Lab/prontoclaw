import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
} from "../types.js";
import {
  qualityGateHandler,
  auditLogHandler,
  clearQualityEnforcerState,
} from "./quality-enforcer.js";

describe("quality-enforcer", () => {
  beforeEach(() => {
    clearQualityEnforcerState();
  });

  afterEach(() => {
    clearQualityEnforcerState();
  });

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  const createBeforeEvent = (
    toolName: string,
    params: Record<string, unknown> = {},
  ): PluginHookBeforeToolCallEvent => ({
    toolName,
    params,
  });

  const createAfterEvent = (
    toolName: string,
    opts: Partial<PluginHookAfterToolCallEvent> = {},
  ): PluginHookAfterToolCallEvent => ({
    toolName,
    params: {},
    ...opts,
  });

  const createContext = (agentId = "main", sessionKey = "test-session"): PluginHookToolContext =>
    ({
      toolName: "unused",
      agentId,
      sessionKey,
    }) as PluginHookToolContext;

  // -----------------------------------------------------------------------
  // Read-Before-Write Gate
  // -----------------------------------------------------------------------

  describe("read-before-write gate", () => {
    it("blocks write without prior read", async () => {
      const result = await qualityGateHandler(
        createBeforeEvent("write", { filePath: "/tmp/foo.ts" }),
        createContext(),
      );
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain("QUALITY GATE");
      expect(result?.blockReason).toContain("/tmp/foo.ts");
    });

    it("blocks edit without prior read", async () => {
      const result = await qualityGateHandler(
        createBeforeEvent("edit", { filePath: "/tmp/bar.ts" }),
        createContext(),
      );
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain("QUALITY GATE");
    });

    it("allows write after read of same file", async () => {
      const ctx = createContext();

      // Read first
      await qualityGateHandler(createBeforeEvent("read", { filePath: "/tmp/foo.ts" }), ctx);

      // Then write should be allowed
      const result = await qualityGateHandler(
        createBeforeEvent("write", { filePath: "/tmp/foo.ts" }),
        ctx,
      );
      expect(result?.block).not.toBe(true);
    });

    it("allows edit after read of same file", async () => {
      const ctx = createContext();

      await qualityGateHandler(createBeforeEvent("read", { filePath: "/tmp/foo.ts" }), ctx);

      const result = await qualityGateHandler(
        createBeforeEvent("edit", { filePath: "/tmp/foo.ts" }),
        ctx,
      );
      expect(result?.block).not.toBe(true);
    });

    it("blocks write to a different file than what was read", async () => {
      const ctx = createContext();

      await qualityGateHandler(createBeforeEvent("read", { filePath: "/tmp/foo.ts" }), ctx);

      const result = await qualityGateHandler(
        createBeforeEvent("write", { filePath: "/tmp/other.ts" }),
        ctx,
      );
      expect(result?.block).toBe(true);
    });

    it("tracks multiple read files per session", async () => {
      const ctx = createContext();

      await qualityGateHandler(createBeforeEvent("read", { filePath: "/tmp/a.ts" }), ctx);
      await qualityGateHandler(createBeforeEvent("read", { filePath: "/tmp/b.ts" }), ctx);

      const resultA = await qualityGateHandler(
        createBeforeEvent("write", { filePath: "/tmp/a.ts" }),
        ctx,
      );
      const resultB = await qualityGateHandler(
        createBeforeEvent("edit", { filePath: "/tmp/b.ts" }),
        ctx,
      );

      expect(resultA?.block).not.toBe(true);
      expect(resultB?.block).not.toBe(true);
    });

    it("handles path param (not just filePath)", async () => {
      const ctx = createContext();

      await qualityGateHandler(createBeforeEvent("read", { path: "/tmp/via-path.ts" }), ctx);

      const result = await qualityGateHandler(
        createBeforeEvent("write", { path: "/tmp/via-path.ts" }),
        ctx,
      );
      expect(result?.block).not.toBe(true);
    });

    it("normalizes file paths (trailing slashes, dots)", async () => {
      const ctx = createContext();

      await qualityGateHandler(createBeforeEvent("read", { filePath: "/tmp/./foo.ts" }), ctx);

      const result = await qualityGateHandler(
        createBeforeEvent("write", { filePath: "/tmp/foo.ts" }),
        ctx,
      );
      expect(result?.block).not.toBe(true);
    });

    it("lets through write/edit with no file path in params", async () => {
      const result = await qualityGateHandler(createBeforeEvent("write", {}), createContext());
      expect(result?.block).not.toBe(true);
    });

    it("lets through non-write/edit tools without restriction", async () => {
      const result = await qualityGateHandler(
        createBeforeEvent("exec", { command: "ls" }),
        createContext(),
      );
      expect(result?.block).not.toBe(true);
    });

    it("lets through grep, find, ls without restriction", async () => {
      for (const tool of ["grep", "find", "ls", "web_search"]) {
        const result = await qualityGateHandler(createBeforeEvent(tool, {}), createContext());
        expect(result?.block).not.toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Subagent Exemption
  // -----------------------------------------------------------------------

  describe("subagent exemption", () => {
    it("exempts subagent sessions from read-before-write", async () => {
      const ctx = createContext("main", "subagent:explorer:abc123");

      const result = await qualityGateHandler(
        createBeforeEvent("write", { filePath: "/tmp/foo.ts" }),
        ctx,
      );
      expect(result?.block).not.toBe(true);
    });

    it("enforces gate for non-subagent sessions", async () => {
      const ctx = createContext("main", "discord:channel:123");

      const result = await qualityGateHandler(
        createBeforeEvent("write", { filePath: "/tmp/foo.ts" }),
        ctx,
      );
      expect(result?.block).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Session Isolation
  // -----------------------------------------------------------------------

  describe("session isolation", () => {
    it("tracks reads per session independently", async () => {
      const ctx1 = createContext("agent1", "session1");
      const ctx2 = createContext("agent2", "session2");

      // Agent 1 reads the file
      await qualityGateHandler(createBeforeEvent("read", { filePath: "/tmp/foo.ts" }), ctx1);

      // Agent 2 should still be blocked (didn't read)
      const result = await qualityGateHandler(
        createBeforeEvent("write", { filePath: "/tmp/foo.ts" }),
        ctx2,
      );
      expect(result?.block).toBe(true);

      // Agent 1 should be allowed
      const result1 = await qualityGateHandler(
        createBeforeEvent("write", { filePath: "/tmp/foo.ts" }),
        ctx1,
      );
      expect(result1?.block).not.toBe(true);
    });

    it("returns undefined for missing agentId", async () => {
      const ctx = { toolName: "write", sessionKey: "test" } as PluginHookToolContext;
      const result = await qualityGateHandler(
        createBeforeEvent("write", { filePath: "/tmp/foo.ts" }),
        ctx,
      );
      // No agentId means no session key, so it passes through
      expect(result?.block).not.toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // State Management
  // -----------------------------------------------------------------------

  describe("state management", () => {
    it("clearQualityEnforcerState resets all tracked reads", async () => {
      const ctx = createContext();

      await qualityGateHandler(createBeforeEvent("read", { filePath: "/tmp/foo.ts" }), ctx);

      clearQualityEnforcerState();

      // After clear, write should be blocked again
      const result = await qualityGateHandler(
        createBeforeEvent("write", { filePath: "/tmp/foo.ts" }),
        ctx,
      );
      expect(result?.block).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Audit Logging (after_tool_call)
  // -----------------------------------------------------------------------

  describe("audit logging", () => {
    it("does not throw for write audit", async () => {
      await expect(
        auditLogHandler(createAfterEvent("write", { durationMs: 100 }), createContext()),
      ).resolves.not.toThrow();
    });

    it("does not throw for edit audit", async () => {
      await expect(
        auditLogHandler(createAfterEvent("edit", { durationMs: 50 }), createContext()),
      ).resolves.not.toThrow();
    });

    it("does not throw for exec audit", async () => {
      await expect(
        auditLogHandler(createAfterEvent("exec", { durationMs: 200 }), createContext()),
      ).resolves.not.toThrow();
    });

    it("does not throw for exec with error", async () => {
      await expect(
        auditLogHandler(
          createAfterEvent("exec", {
            durationMs: 200,
            error: "Command failed with exit code 1",
          }),
          createContext(),
        ),
      ).resolves.not.toThrow();
    });

    it("skips non-audited tools silently", async () => {
      await expect(
        auditLogHandler(createAfterEvent("read", { durationMs: 10 }), createContext()),
      ).resolves.not.toThrow();
    });

    it("handles missing context fields gracefully", async () => {
      await expect(
        auditLogHandler(createAfterEvent("write", { durationMs: 100 }), {
          toolName: "write",
        } as PluginHookToolContext),
      ).resolves.not.toThrow();
    });
  });
});
