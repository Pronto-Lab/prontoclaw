import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import type { Logger } from "./service/state.js";
import {
  isCronRunSessionKey,
  isA2ASessionKey,
  parseA2ASessionKey,
} from "../sessions/session-key-utils.js";
import {
  sweepCronRunSessions,
  sweepA2ASessions,
  resolveRetentionMs,
  resetReaperThrottle,
} from "./session-reaper.js";

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe("resolveRetentionMs", () => {
  it("returns 24h default when no config", () => {
    expect(resolveRetentionMs()).toBe(24 * 3_600_000);
  });

  it("returns 24h default when config is empty", () => {
    expect(resolveRetentionMs({})).toBe(24 * 3_600_000);
  });

  it("parses duration string", () => {
    expect(resolveRetentionMs({ sessionRetention: "1h" })).toBe(3_600_000);
    expect(resolveRetentionMs({ sessionRetention: "7d" })).toBe(7 * 86_400_000);
    expect(resolveRetentionMs({ sessionRetention: "30m" })).toBe(30 * 60_000);
  });

  it("returns null when disabled", () => {
    expect(resolveRetentionMs({ sessionRetention: false })).toBeNull();
  });

  it("falls back to default on invalid string", () => {
    expect(resolveRetentionMs({ sessionRetention: "abc" })).toBe(24 * 3_600_000);
  });
});

describe("isCronRunSessionKey", () => {
  it("matches cron run session keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc-123:run:def-456")).toBe(true);
    expect(isCronRunSessionKey("agent:debugger:cron:249ecf82:run:1102aabb")).toBe(true);
  });

  it("does not match base cron session keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc-123")).toBe(false);
  });

  it("does not match regular session keys", () => {
    expect(isCronRunSessionKey("agent:main:telegram:dm:123")).toBe(false);
  });

  it("does not match non-canonical cron-like keys", () => {
    expect(isCronRunSessionKey("agent:main:slack:cron:job:run:uuid")).toBe(false);
    expect(isCronRunSessionKey("cron:job:run:uuid")).toBe(false);
  });
});

describe("sweepCronRunSessions", () => {
  let tmpDir: string;
  let storePath: string;
  const log = createTestLogger();

  beforeEach(async () => {
    resetReaperThrottle();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-reaper-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  it("prunes expired cron run sessions", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1": {
        sessionId: "base-session",
        updatedAt: now,
      },
      "agent:main:cron:job1:run:old-run": {
        sessionId: "old-run",
        updatedAt: now - 25 * 3_600_000, // 25h ago — expired
      },
      "agent:main:cron:job1:run:recent-run": {
        sessionId: "recent-run",
        updatedAt: now - 1 * 3_600_000, // 1h ago — not expired
      },
      "agent:main:telegram:dm:123": {
        sessionId: "regular-session",
        updatedAt: now - 100 * 3_600_000, // old but not a cron run
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(1);

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:cron:job1"]).toBeDefined();
    expect(updated["agent:main:cron:job1:run:old-run"]).toBeUndefined();
    expect(updated["agent:main:cron:job1:run:recent-run"]).toBeDefined();
    expect(updated["agent:main:telegram:dm:123"]).toBeDefined();
  });

  it("respects custom retention", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:run1": {
        sessionId: "run1",
        updatedAt: now - 2 * 3_600_000, // 2h ago
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: "1h" },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
  });

  it("does nothing when pruning is disabled", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:run1": {
        sessionId: "run1",
        updatedAt: now - 100 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: false },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(false);
    expect(result.pruned).toBe(0);
  });

  it("throttles sweeps without force", async () => {
    const now = Date.now();
    fs.writeFileSync(storePath, JSON.stringify({}));

    // First sweep runs
    const r1 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });
    expect(r1.swept).toBe(true);

    // Second sweep (1 second later) is throttled
    const r2 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now + 1000,
      log,
    });
    expect(r2.swept).toBe(false);
  });

  it("throttles per store path", async () => {
    const now = Date.now();
    const otherPath = path.join(tmpDir, "sessions-other.json");
    fs.writeFileSync(storePath, JSON.stringify({}));
    fs.writeFileSync(otherPath, JSON.stringify({}));

    const r1 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });
    expect(r1.swept).toBe(true);

    const r2 = await sweepCronRunSessions({
      sessionStorePath: otherPath,
      nowMs: now + 1000,
      log,
    });
    expect(r2.swept).toBe(true);

    const r3 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now + 1000,
      log,
    });
    expect(r3.swept).toBe(false);
  });
});

describe("isA2ASessionKey", () => {
  it("matches A2A session keys", () => {
    expect(isA2ASessionKey("agent:seum:a2a:conv-abc123")).toBe(true);
    expect(isA2ASessionKey("agent:eden:a2a:12345")).toBe(true);
  });

  it("does not match regular session keys", () => {
    expect(isA2ASessionKey("agent:main:telegram:dm:123")).toBe(false);
    expect(isA2ASessionKey("agent:main:main")).toBe(false);
  });

  it("does not match cron session keys", () => {
    expect(isA2ASessionKey("agent:main:cron:abc-123:run:def-456")).toBe(false);
  });

  it("does not match malformed keys", () => {
    expect(isA2ASessionKey("")).toBe(false);
    expect(isA2ASessionKey(null)).toBe(false);
    expect(isA2ASessionKey(undefined)).toBe(false);
    expect(isA2ASessionKey("a2a:conv-abc")).toBe(false);
  });
});

describe("parseA2ASessionKey", () => {
  it("parses valid A2A session keys", () => {
    const result = parseA2ASessionKey("agent:seum:a2a:conv-abc123");
    expect(result).toEqual({ agentId: "seum", conversationId: "conv-abc123" });
  });

  it("returns null for non-A2A keys", () => {
    expect(parseA2ASessionKey("agent:main:telegram:dm:123")).toBeNull();
    expect(parseA2ASessionKey("agent:main:cron:job1:run:uuid")).toBeNull();
    expect(parseA2ASessionKey(null)).toBeNull();
  });
});

describe("sweepA2ASessions", () => {
  let tmpDir: string;
  let storePath: string;
  const log = createTestLogger();

  beforeEach(async () => {
    resetReaperThrottle();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-reaper-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  it("prunes expired A2A sessions by TTL", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:seum:a2a:conv-old": {
        sessionId: "conv-old",
        updatedAt: now - 2 * 3_600_000, // 2h ago
      },
      "agent:seum:a2a:conv-recent": {
        sessionId: "conv-recent",
        updatedAt: now - 30 * 60_000, // 30m ago
      },
      "agent:seum:main": {
        sessionId: "main-session",
        updatedAt: now - 100 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepA2ASessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(1);

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:seum:a2a:conv-old"]).toBeUndefined();
    expect(updated["agent:seum:a2a:conv-recent"]).toBeDefined();
    expect(updated["agent:seum:main"]).toBeDefined();
  });

  it("prunes excess A2A sessions per agent (cap-based)", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {};

    for (let i = 0; i < 18; i++) {
      store[`agent:seum:a2a:conv-${String(i).padStart(3, "0")}`] = {
        sessionId: `conv-${i}`,
        updatedAt: now - (18 - i) * 60_000,
      };
    }
    store["agent:eden:a2a:conv-001"] = {
      sessionId: "eden-conv",
      updatedAt: now - 10 * 60_000,
    };

    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepA2ASessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(2);

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:seum:a2a:conv-000"]).toBeUndefined();
    expect(updated["agent:seum:a2a:conv-001"]).toBeUndefined();
    expect(updated["agent:seum:a2a:conv-002"]).toBeDefined();
    expect(updated["agent:seum:a2a:conv-017"]).toBeDefined();
    expect(updated["agent:eden:a2a:conv-001"]).toBeDefined();
  });

  it("does nothing when TTL pruning is disabled", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:seum:a2a:conv-old": {
        sessionId: "conv-old",
        updatedAt: now - 100 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepA2ASessions({
      a2aConfig: { ttl: false },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(false);
    expect(result.pruned).toBe(0);
  });

  it("respects custom TTL", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:seum:a2a:conv-1": {
        sessionId: "conv-1",
        updatedAt: now - 35 * 60_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepA2ASessions({
      a2aConfig: { ttl: "30m" },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
  });

  it("throttles sweeps without force", async () => {
    const now = Date.now();
    fs.writeFileSync(storePath, JSON.stringify({}));

    const r1 = await sweepA2ASessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });
    expect(r1.swept).toBe(true);

    const r2 = await sweepA2ASessions({
      sessionStorePath: storePath,
      nowMs: now + 1000,
      log,
    });
    expect(r2.swept).toBe(false);
  });

  it("respects custom maxPerAgent", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {};
    for (let i = 0; i < 5; i++) {
      store[`agent:seum:a2a:conv-${i}`] = {
        sessionId: `conv-${i}`,
        updatedAt: now - (5 - i) * 60_000,
      };
    }
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepA2ASessions({
      a2aConfig: { maxPerAgent: 3 },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(2);
  });
});
