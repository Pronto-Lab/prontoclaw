import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireTaskLock } from "./task-lock.js";

describe("task-lock", () => {
  let testDir: string;
  const taskId = "task_test123";

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-lock-test-"));
    await fs.mkdir(path.join(testDir, "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("acquireTaskLock", () => {
    it("acquires lock successfully when no lock exists", async () => {
      const lock = await acquireTaskLock(testDir, taskId);
      expect(lock).not.toBeNull();
      await lock!.release();
    });

    it("returns null when lock already held", async () => {
      const lock1 = await acquireTaskLock(testDir, taskId);
      expect(lock1).not.toBeNull();

      const lock2 = await acquireTaskLock(testDir, taskId);
      expect(lock2).toBeNull();

      await lock1!.release();
    });

    it("releases lock correctly", async () => {
      const lock1 = await acquireTaskLock(testDir, taskId);
      await lock1!.release();

      const lock2 = await acquireTaskLock(testDir, taskId);
      expect(lock2).not.toBeNull();
      await lock2!.release();
    });

    it("cleans up stale lock with old timestamp", async () => {
      const lockPath = path.join(testDir, "tasks", `${taskId}.lock`);
      const staleData = {
        pid: 99999999, // Non-existent PID
        timestamp: new Date(Date.now() - 120_000).toISOString(), // 2 min old
      };
      await fs.writeFile(lockPath, JSON.stringify(staleData));

      const lock = await acquireTaskLock(testDir, taskId);
      expect(lock).not.toBeNull();
      await lock!.release();
    });

    it("cleans up lock when owner process is dead", async () => {
      const lockPath = path.join(testDir, "tasks", `${taskId}.lock`);
      const deadPidData = {
        pid: 99999999, // Non-existent PID
        timestamp: new Date().toISOString(), // Fresh timestamp
      };
      await fs.writeFile(lockPath, JSON.stringify(deadPidData));

      const lock = await acquireTaskLock(testDir, taskId);
      expect(lock).not.toBeNull();
      await lock!.release();
    });

    it("returns null for valid lock with alive process", async () => {
      const lockPath = path.join(testDir, "tasks", `${taskId}.lock`);
      const validData = {
        pid: process.pid, // Current process (alive)
        timestamp: new Date().toISOString(),
      };
      await fs.writeFile(lockPath, JSON.stringify(validData));

      const lock = await acquireTaskLock(testDir, taskId);
      expect(lock).toBeNull();

      // Cleanup
      await fs.unlink(lockPath);
    });

    it("returns null when tasks directory does not exist", async () => {
      const lock = await acquireTaskLock("/nonexistent/path/that/does/not/exist", taskId);
      expect(lock).toBeNull();
    });

    it("handles malformed lock file gracefully", async () => {
      const lockPath = path.join(testDir, "tasks", `${taskId}.lock`);
      await fs.writeFile(lockPath, "not valid json");

      const lock = await acquireTaskLock(testDir, taskId);
      expect(lock).not.toBeNull();
      await lock!.release();
    });
  });
});
