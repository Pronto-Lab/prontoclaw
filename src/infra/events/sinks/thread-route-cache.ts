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
  private pairIndex = new Map<string, string[]>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, CACHE_FILENAME);
  }

  private pairKey(agents: [string, string]): string {
    return [...agents].toSorted().join(":");
  }

  async load(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.filePath, "utf-8");
      this.data = JSON.parse(raw) as ThreadRouteData;
      this.rebuildPairIndex();
      log.info("cache loaded", {
        consoleMessage: `thread-route-cache loaded: ${Object.keys(this.data.entries).length} entries`,
        entryCount: Object.keys(this.data.entries).length,
      });
    } catch {
      this.data = { version: 1, entries: {}, updatedAt: 0 };
      this.pairIndex.clear();
      log.info("cache initialized (no existing file)");
    }
  }

  get(conversationId: string): ThreadRouteEntry | undefined {
    return this.data.entries[conversationId];
  }

  set(conversationId: string, entry: ThreadRouteEntry): void {
    this.data.entries[conversationId] = entry;
    const key = this.pairKey(entry.agents);
    if (!this.pairIndex.has(key)) {
      this.pairIndex.set(key, []);
    }
    const ids = this.pairIndex.get(key)!;
    if (!ids.includes(conversationId)) {
      ids.push(conversationId);
    }
    this.data.updatedAt = Date.now();
    this.enqueueWrite();
  }

  getByAgentPair(agents: [string, string]): ThreadRouteEntry | undefined {
    const key = this.pairKey(agents);
    const candidateIds = this.pairIndex.get(key);
    if (!candidateIds || candidateIds.length === 0) {
      return undefined;
    }
    let newest: ThreadRouteEntry | undefined;
    for (const id of candidateIds) {
      const entry = this.data.entries[id];
      if (entry && (!newest || entry.createdAt > newest.createdAt)) {
        newest = entry;
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

  private rebuildPairIndex(): void {
    this.pairIndex.clear();
    for (const [conversationId, entry] of Object.entries(this.data.entries)) {
      const key = this.pairKey(entry.agents);
      if (!this.pairIndex.has(key)) {
        this.pairIndex.set(key, []);
      }
      this.pairIndex.get(key)!.push(conversationId);
    }
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
