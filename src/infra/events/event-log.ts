import fs from "node:fs";
import path from "node:path";
import type { CoordinationEvent } from "./bus.js";
import { subscribe } from "./bus.js";

let logStream: fs.WriteStream | null = null;
let unsubscribe: (() => void) | null = null;

export function startEventLog(logDir: string): void {
  if (logStream) {
    return;
  }
  fs.mkdirSync(logDir, { recursive: true });
  const filePath = path.join(logDir, "coordination-events.ndjson");
  logStream = fs.createWriteStream(filePath, { flags: "a" });

  unsubscribe = subscribe("*", (event: CoordinationEvent) => {
    if (!logStream) {
      return;
    }
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
  if (logStream) {
    const stream = logStream;
    logStream = null;
    return new Promise((resolve) => {
      stream.end(resolve);
    });
  }
  return Promise.resolve();
}
