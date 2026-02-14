import fs from "node:fs";
import path from "node:path";
import type { CoordinationEvent } from "./bus.js";
import { subscribe } from "./bus.js";

let logStream: fs.WriteStream | null = null;
let unsubscribe: (() => void) | null = null;

const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
let currentLogMonth: string | null = null;
let logFilePath: string | null = null;
let logDirPath: string | null = null;

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function rotateIfNeeded(): void {
  if (!logFilePath || !logDirPath || !logStream) {
    return;
  }

  const month = getCurrentMonth();

  // Monthly rotation
  if (currentLogMonth && currentLogMonth !== month) {
    const archiveName = `coordination-events-${currentLogMonth}.ndjson`;
    const archivePath = path.join(logDirPath, archiveName);
    try {
      logStream.end();
      fs.renameSync(logFilePath, archivePath);
      logStream = fs.createWriteStream(logFilePath, { flags: "a" });
    } catch {
      /* ignore */
    }
    currentLogMonth = month;
    return;
  }

  // Size cap rotation
  try {
    const stats = fs.statSync(logFilePath);
    if (stats.size > MAX_LOG_SIZE_BYTES) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const archiveName = `coordination-events-${ts}.ndjson`;
      const archivePath = path.join(logDirPath, archiveName);
      logStream.end();
      fs.renameSync(logFilePath, archivePath);
      logStream = fs.createWriteStream(logFilePath, { flags: "a" });
    }
  } catch {
    /* ignore */
  }
}

export function startEventLog(logDir: string): void {
  if (logStream) {
    return;
  }
  fs.mkdirSync(logDir, { recursive: true });
  const filePath = path.join(logDir, "coordination-events.ndjson");
  logStream = fs.createWriteStream(filePath, { flags: "a" });
  logFilePath = filePath;
  logDirPath = logDir;
  currentLogMonth = getCurrentMonth();

  unsubscribe = subscribe("*", (event: CoordinationEvent) => {
    if (!logStream) {
      return;
    }
    rotateIfNeeded();
    try {
      logStream.write(JSON.stringify(event) + "\n");
    } catch {
      // swallow write errors
    }
  });
}

export function stopEventLog(): Promise<void> {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  currentLogMonth = null;
  logFilePath = null;
  logDirPath = null;
  if (logStream) {
    const stream = logStream;
    logStream = null;
    return new Promise((resolve) => {
      stream.end(resolve);
    });
  }
  return Promise.resolve();
}
