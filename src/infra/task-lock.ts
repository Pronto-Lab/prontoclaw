import fs from "node:fs/promises";
import path from "node:path";

const _LOCK_TIMEOUT_MS = 30_000; // 30 seconds max lock hold time
const LOCK_STALE_MS = 60_000; // Consider lock stale after 60 seconds

/**
 * Check if a process is still alive by sending signal 0.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 checks existence without killing
    return true;
  } catch {
    return false;
  }
}

export interface TaskLock {
  release: () => Promise<void>;
}

/**
 * Try to acquire a lock for a task file.
 * Returns lock object if acquired, null if already locked.
 */
export async function acquireTaskLock(
  workspaceDir: string,
  taskId: string,
): Promise<TaskLock | null> {
  const lockPath = path.join(workspaceDir, "tasks", `${taskId}.lock`);

  try {
    // Check for stale lock
    try {
      const content = await fs.readFile(lockPath, "utf-8");
      const lockData = JSON.parse(content) as {
        pid: number;
        timestamp: string;
        startTime?: number;
      };
      const ageMs = Date.now() - new Date(lockData.timestamp).getTime();

      // Lock is stale if too old OR owner process is dead
      if (ageMs > LOCK_STALE_MS || !isProcessAlive(lockData.pid)) {
        await fs.unlink(lockPath).catch(() => {});
      } else {
        // Lock is valid and owner is alive
        return null;
      }
    } catch (readErr) {
      // Lock file doesn't exist or is invalid, proceed with acquisition
      // If file exists but is malformed, clean it up before re-acquiring
      if ((readErr as NodeJS.ErrnoException).code !== "ENOENT") {
        await fs.unlink(lockPath).catch(() => {});
      }
    }

    // Try to create lock file with exclusive flag
    const handle = await fs.open(lockPath, "wx");
    await handle.write(
      JSON.stringify({
        pid: process.pid,
        timestamp: new Date().toISOString(),
        startTime: process.uptime(),
      }),
    );
    await handle.close();

    return {
      release: async () => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // Ignore errors on unlock
        }
      },
    };
  } catch (error) {
    // EEXIST means lock already held
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    // For other errors (e.g., directory doesn't exist), also return null
    return null;
  }
}
