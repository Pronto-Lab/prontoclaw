import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { emit, reset } from "./bus.js";
import {
  startA2AIndex,
  stopA2AIndex,
  flushA2AIndex,
  getA2AConversationId,
  getA2AIndex,
} from "./a2a-index.js";

let tmpDir: string;

beforeEach(() => {
  reset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-index-test-"));
});

afterEach(async () => {
  await stopA2AIndex();
  reset();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function emitA2A(
  type: "a2a.send" | "a2a.response" | "a2a.complete",
  overrides: Record<string, unknown> = {},
) {
  const base = {
    fromAgent: "eden",
    toAgent: "ruda",
    workSessionId: "ws-1",
    conversationId: "conv-abc",
    eventRole: "conversation.main",
    runId: "run-1",
  };
  emit({
    type,
    agentId: String(overrides.fromAgent ?? base.fromAgent),
    ts: typeof overrides.ts === "number" ? overrides.ts : Date.now(),
    data: { ...base, ...overrides },
  });
}

describe("A2AIndexWriter", () => {
  it("a2a.send event adds entry to index", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send");
    await flushA2AIndex();

    const convId = await getA2AConversationId("ws-1::eden|ruda");
    expect(convId).toBe("conv-abc");
  });

  it("a2a.response event updates index", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.response", { conversationId: "conv-resp" });
    await flushA2AIndex();

    const convId = await getA2AConversationId("ws-1::eden|ruda");
    expect(convId).toBe("conv-resp");
  });

  it("a2a.complete event updates index", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.complete", { conversationId: "conv-done" });
    await flushA2AIndex();

    const convId = await getA2AConversationId("ws-1::eden|ruda");
    expect(convId).toBe("conv-done");
  });

  it("newer event overwrites older one for same routeKey", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send", { conversationId: "conv-old", ts: 1000 });
    emitA2A("a2a.send", { conversationId: "conv-new", ts: 2000 });
    await flushA2AIndex();

    const convId = await getA2AConversationId("ws-1::eden|ruda");
    expect(convId).toBe("conv-new");
  });

  it("older event does NOT overwrite newer one", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send", { conversationId: "conv-new", ts: 2000 });
    emitA2A("a2a.send", { conversationId: "conv-old", ts: 1000 });
    await flushA2AIndex();

    const convId = await getA2AConversationId("ws-1::eden|ruda");
    expect(convId).toBe("conv-new");
  });

  it("agent pair is sorted so from/to order does not matter", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send", { fromAgent: "ruda", toAgent: "eden", conversationId: "conv-rev" });
    await flushA2AIndex();

    // routeKey is always sorted: eden|ruda regardless of from/to order
    const convId = await getA2AConversationId("ws-1::eden|ruda");
    expect(convId).toBe("conv-rev");
  });

  it("different routeKeys are stored independently", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send", { workSessionId: "ws-1", conversationId: "conv-1" });
    emitA2A("a2a.send", { workSessionId: "ws-2", conversationId: "conv-2" });
    await flushA2AIndex();

    expect(await getA2AConversationId("ws-1::eden|ruda")).toBe("conv-1");
    expect(await getA2AConversationId("ws-2::eden|ruda")).toBe("conv-2");
  });

  it("ignores events without eventRole=conversation.main", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send", { eventRole: "delegation.subagent" });
    await flushA2AIndex();

    const convId = await getA2AConversationId("ws-1::eden|ruda");
    expect(convId).toBeUndefined();
  });

  it("ignores events without workSessionId", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send", { workSessionId: undefined });
    await flushA2AIndex();

    // No valid events means no index file created
    const convId = await getA2AConversationId("ws-1::eden|ruda");
    expect(convId).toBeUndefined();
  });

  it("ignores events without conversationId", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send", { conversationId: undefined });
    await flushA2AIndex();

    // No valid events means no index file created
    const convId = await getA2AConversationId("ws-1::eden|ruda");
    expect(convId).toBeUndefined();
  });

  it("handles concurrent events without file corruption", async () => {
    startA2AIndex(tmpDir);
    for (let i = 0; i < 10; i++) {
      emitA2A("a2a.send", {
        workSessionId: `ws-${i}`,
        conversationId: `conv-${i}`,
        ts: 1000 + i,
      });
    }
    await flushA2AIndex();

    const index = await getA2AIndex();
    expect(index).not.toBeNull();
    expect(Object.keys(index!.entries)).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(index!.entries[`ws-${i}::eden|ruda`].conversationId).toBe(`conv-${i}`);
    }
  });

  it("index file is not created before first event", async () => {
    startA2AIndex(tmpDir);
    await flushA2AIndex();

    const indexPath = path.join(tmpDir, "a2a-conversation-index.json");
    expect(fs.existsSync(indexPath)).toBe(false);
  });

  it("index file is valid JSON", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send");
    await flushA2AIndex();

    const indexPath = path.join(tmpDir, "a2a-conversation-index.json");
    const raw = fs.readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed).toHaveProperty("entries");
    expect(parsed).toHaveProperty("updatedAt");
  });

  it("atomic write: no .tmp file left after flush", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send");
    await flushA2AIndex();

    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe("A2AIndexReader", () => {
  it("returns conversationId for existing routeKey", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send");
    await flushA2AIndex();

    const convId = await getA2AConversationId("ws-1::eden|ruda");
    expect(convId).toBe("conv-abc");
  });

  it("returns undefined for missing routeKey", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send");
    await flushA2AIndex();

    const convId = await getA2AConversationId("ws-99::foo|bar");
    expect(convId).toBeUndefined();
  });

  it("returns undefined when index file does not exist", async () => {
    startA2AIndex(tmpDir);
    const convId = await getA2AConversationId("ws-1::eden|ruda");
    expect(convId).toBeUndefined();
  });

  it("returns undefined when not started", async () => {
    // startA2AIndex not called
    const convId = await getA2AConversationId("ws-1::eden|ruda");
    expect(convId).toBeUndefined();
  });

  it("getA2AIndex returns full index", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send", { workSessionId: "ws-1", conversationId: "conv-1" });
    emitA2A("a2a.send", { workSessionId: "ws-2", conversationId: "conv-2" });
    await flushA2AIndex();

    const index = await getA2AIndex();
    expect(index).not.toBeNull();
    expect(index!.version).toBe(1);
    expect(Object.keys(index!.entries)).toHaveLength(2);
  });

  it("getA2AIndex returns null when not started", async () => {
    const index = await getA2AIndex();
    expect(index).toBeNull();
  });
});

describe("lifecycle", () => {
  it("does not fail when stopA2AIndex called without start", async () => {
    await expect(stopA2AIndex()).resolves.not.toThrow();
  });

  it("does not start twice", async () => {
    startA2AIndex(tmpDir);
    startA2AIndex(tmpDir); // should be no-op

    emitA2A("a2a.send");
    await flushA2AIndex();

    // Only one entry (not duplicated by double subscription)
    const index = await getA2AIndex();
    expect(Object.keys(index!.entries)).toHaveLength(1);
  });

  it("stopA2AIndex resets state and allows restart", async () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-index-test-"));
    try {
      startA2AIndex(tmpDir);
      emitA2A("a2a.send", { conversationId: "conv-dir1" });
      await stopA2AIndex();

      startA2AIndex(tmpDir2);
      emitA2A("a2a.send", { conversationId: "conv-dir2" });
      await stopA2AIndex();

      // Verify both dirs have their own index
      const raw1 = fs.readFileSync(
        path.join(tmpDir, "a2a-conversation-index.json"),
        "utf-8",
      );
      const raw2 = fs.readFileSync(
        path.join(tmpDir2, "a2a-conversation-index.json"),
        "utf-8",
      );
      const index1 = JSON.parse(raw1);
      const index2 = JSON.parse(raw2);
      expect(index1.entries["ws-1::eden|ruda"].conversationId).toBe("conv-dir1");
      expect(index2.entries["ws-1::eden|ruda"].conversationId).toBe("conv-dir2");
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it("events after stop are not written", async () => {
    startA2AIndex(tmpDir);
    emitA2A("a2a.send", { conversationId: "conv-before" });
    await stopA2AIndex();

    // Emit after stop — should be ignored
    emit({
      type: "a2a.send",
      agentId: "eden",
      ts: Date.now(),
      data: {
        fromAgent: "eden",
        toAgent: "ruda",
        workSessionId: "ws-2",
        conversationId: "conv-after",
        eventRole: "conversation.main",
      },
    });

    // Re-read index from disk
    const raw = fs.readFileSync(
      path.join(tmpDir, "a2a-conversation-index.json"),
      "utf-8",
    );
    const index = JSON.parse(raw);
    expect(Object.keys(index.entries)).toHaveLength(1);
    expect(index.entries["ws-1::eden|ruda"].conversationId).toBe("conv-before");
  });
});
