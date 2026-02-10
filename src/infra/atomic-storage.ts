import fs from "node:fs/promises";
import { acquireTaskLock, type TaskLock } from "./task-lock.js";

export async function atomicReadModifyWrite<T>(
  filePath: string,
  lockDir: string,
  lockId: string,
  defaultValue: T,
  modify: (current: T) => T,
): Promise<T> {
  let lock: TaskLock | null = null;
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    lock = await acquireTaskLock(lockDir, lockId);
    if (lock) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50 * Math.pow(2, attempt)));
  }
  if (!lock) {
    throw new Error(`Failed to acquire lock for ${lockId} after ${maxRetries} retries`);
  }

  try {
    let current: T;
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      current = JSON.parse(raw) as T;
    } catch {
      current = defaultValue;
    }

    const updated = modify(current);

    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tempPath, JSON.stringify(updated, null, 2), "utf-8");
    await fs.rename(tempPath, filePath);

    return updated;
  } finally {
    await lock.release();
  }
}

export async function atomicRead<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}
