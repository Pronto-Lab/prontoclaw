import fs from "node:fs/promises";
import path from "node:path";

const LOCK_TIMEOUT_MS = 30_000; // 30 seconds max lock hold time
const LOCK_STALE_MS = 60_000;   // Consider lock stale after 60 seconds

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
      const stat = await fs.stat(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > LOCK_STALE_MS) {
        // Stale lock, remove it
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch {
      // Lock file doesn't exist, good
    }

    // Try to create lock file with exclusive flag
    const handle = await fs.open(lockPath, "wx");
    await handle.write(JSON.stringify({ 
      pid: process.pid, 
      timestamp: new Date().toISOString() 
    }));
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
