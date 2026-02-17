import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { atomicReadModifyWrite, atomicRead } from "./atomic-storage.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-storage-test-"));
  fs.mkdirSync(path.join(tmpDir, "tasks"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("atomicReadModifyWrite", () => {
  it("creates file with default when not exists", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const result = await atomicReadModifyWrite(
      filePath,
      tmpDir,
      "test_lock",
      { count: 0 },
      (s) => ({ count: s.count + 1 }),
    );

    expect(result).toEqual({ count: 1 });
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.count).toBe(1);
  });

  it("reads and modifies existing file", async () => {
    const filePath = path.join(tmpDir, "state.json");
    fs.writeFileSync(filePath, JSON.stringify({ count: 5 }));

    const result = await atomicReadModifyWrite(
      filePath,
      tmpDir,
      "test_lock",
      { count: 0 },
      (s) => ({ count: s.count + 10 }),
    );

    expect(result).toEqual({ count: 15 });
  });

  it("handles sequential modifications correctly", async () => {
    const filePath = path.join(tmpDir, "state.json");
    fs.writeFileSync(filePath, JSON.stringify({ count: 0 }));

    for (let i = 0; i < 3; i++) {
      await atomicReadModifyWrite(filePath, tmpDir, "test_lock", { count: 0 }, (s) => ({
        count: s.count + 1,
      }));
    }

    const final = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(final.count).toBe(3);
  });
});

describe("atomicRead", () => {
  it("returns default when file missing", async () => {
    const result = await atomicRead(path.join(tmpDir, "nonexistent.json"), { x: 42 });
    expect(result).toEqual({ x: 42 });
  });

  it("reads existing file", async () => {
    const filePath = path.join(tmpDir, "data.json");
    fs.writeFileSync(filePath, JSON.stringify({ x: 99 }));
    const result = await atomicRead(filePath, { x: 0 });
    expect(result).toEqual({ x: 99 });
  });
});
