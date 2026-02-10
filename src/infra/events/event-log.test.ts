import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { emit, reset } from "./bus.js";
import { startEventLog, stopEventLog } from "./event-log.js";

let tmpDir: string;

beforeEach(() => {
  reset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "event-log-test-"));
});

afterEach(async () => {
  await stopEventLog();
  reset();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("event log", () => {
  it("writes events as NDJSON", async () => {
    startEventLog(tmpDir);

    emit({
      type: "task.started",
      agentId: "main",
      ts: 1000,
      data: { taskId: "t1" },
    });

    emit({
      type: "task.completed",
      agentId: "main",
      ts: 2000,
      data: { taskId: "t1" },
    });

    await stopEventLog();

    const logFile = path.join(tmpDir, "coordination-events.ndjson");
    const content = fs.readFileSync(logFile, "utf-8").trim();
    const lines = content.split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("task.started");
    expect(first.agentId).toBe("main");
    expect(first.data.taskId).toBe("t1");

    const second = JSON.parse(lines[1]);
    expect(second.type).toBe("task.completed");
  });

  it("does not fail when stopEventLog called without start", () => {
    expect(() => stopEventLog()).not.toThrow();
  });

  it("does not start twice", async () => {
    startEventLog(tmpDir);
    startEventLog(tmpDir);

    emit({
      type: "task.started",
      agentId: "main",
      ts: 1000,
      data: {},
    });

    await stopEventLog();
  });
});
