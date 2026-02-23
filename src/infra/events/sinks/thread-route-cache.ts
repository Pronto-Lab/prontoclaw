import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("thread-route-cache");

export interface ThreadRouteEntry {
  threadId: string;
  channelId: string;
  threadName: string;
  agents: [string, string];
  createdAt: number;
}

export interface ThreadRouteData {
  version: 1;
  entries: Record<string, ThreadRouteEntry>;
  updatedAt: number;
}

const CACHE_FILENAME = "thread-route-cache.json";

export class ThreadRouteCache {
  private filePath: string;
  private data: ThreadRouteData = { version: 1, entries: {}, updatedAt: 0 };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, CACHE_FILENAME);
  }

  async load(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.filePath, "utf-8");
      this.data = JSON.parse(raw) as ThreadRouteData;
      log.info("cache loaded", {
        consoleMessage: `thread-route-cache loaded: ${Object.keys(this.data.entries).length} entries`,
        entryCount: Object.keys(this.data.entries).length,
      });
    } catch {
      this.data = { version: 1, entries: {}, updatedAt: 0 };
      log.info("cache initialized (no existing file)");
    }
  }

  get(conversationId: string): ThreadRouteEntry | undefined {
    return this.data.entries[conversationId];
  }

  set(conversationId: string, entry: ThreadRouteEntry): void {
    this.data.entries[conversationId] = entry;
    this.data.updatedAt = Date.now();
    this.enqueueWrite();
  }

  getByAgentPair(agents: [string, string]): ThreadRouteEntry | undefined {
    const sorted = [...agents].toSorted() as [string, string];
    let newest: ThreadRouteEntry | undefined;
    for (const entry of Object.values(this.data.entries)) {
      const entryPair = [...entry.agents].toSorted();
      if (entryPair[0] === sorted[0] && entryPair[1] === sorted[1]) {
        if (!newest || entry.createdAt > newest.createdAt) {
          newest = entry;
        }
      }
    }
    return newest;
  }

  getAllEntries(): Map<string, ThreadRouteEntry> {
    return new Map(Object.entries(this.data.entries));
  }

  private enqueueWrite(): void {
    this.writeQueue = this.writeQueue
      .then(() => this.writeToDisk())
      .catch((err) => {
        log.warn("cache write failed", { error: String(err) });
      });
  }

  private async writeToDisk(): Promise<void> {
    const tmp = this.filePath + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf-8");
    await fsp.rename(tmp, this.filePath);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}
