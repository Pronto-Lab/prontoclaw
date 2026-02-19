import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { subscribe } from "./bus.js";
import type { CoordinationEvent } from "./bus.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("a2a-index");

// --- Types ---

export interface A2AConversationEntry {
  /** Most recent conversationId for this route */
  conversationId: string;
  /** Last event timestamp (ms) */
  timestamp: number;
  /** Last event type */
  lastEventType: "a2a.send" | "a2a.response" | "a2a.complete";
  /** Associated runId (for debugging) */
  runId?: string;
}

export interface A2AConversationIndex {
  /** Schema version (for future migration) */
  version: 1;
  /** routeKey → latest conversation entry */
  entries: Record<string, A2AConversationEntry>;
  /** Index last updated at (epoch ms) */
  updatedAt: number;
}

// --- Constants ---

const A2A_EVENT_TYPES = new Set(["a2a.send", "a2a.response", "a2a.complete"]);
const CONVERSATION_MAIN_ROLE = "conversation.main";
const INDEX_FILENAME = "a2a-conversation-index.json";

// --- Module state ---

let indexFilePath: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let unsubscribes: Array<() => void> = [];

// --- Helpers ---

function extractString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Build a routeKey from event data fields.
 * Must produce the same key as `buildConversationRouteKey` in sessions-send-tool.ts:
 *   `${workSessionId}::${sorted lower-case agent pair joined by |}`
 */
function buildRouteKeyFromEvent(data: Record<string, unknown>): string | undefined {
  const workSessionId = extractString(data.workSessionId);
  if (!workSessionId) return undefined;

  const from = extractString(data.fromAgent);
  const to = extractString(data.toAgent);
  if (!from || !to) return undefined;

  const pair = [from.toLowerCase(), to.toLowerCase()].sort().join("|");
  return `${workSessionId}::${pair}`;
}

// --- Index I/O ---

async function readIndexFile(): Promise<A2AConversationIndex> {
  if (!indexFilePath) {
    return { version: 1, entries: {}, updatedAt: 0 };
  }
  try {
    const raw = await fsp.readFile(indexFilePath, "utf-8");
    return JSON.parse(raw) as A2AConversationIndex;
  } catch {
    return { version: 1, entries: {}, updatedAt: 0 };
  }
}

async function writeIndexFile(index: A2AConversationIndex): Promise<void> {
  if (!indexFilePath) return;
  const tmp = indexFilePath + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(index, null, 2), "utf-8");
  await fsp.rename(tmp, indexFilePath);
}

// --- Writer logic ---

async function updateIndex(event: CoordinationEvent): Promise<void> {
  const data = event.data ?? {};

  // Only index "conversation.main" events (matching the old NDJSON scan filter).
  const eventRole = extractString(data.eventRole);
  if (eventRole !== CONVERSATION_MAIN_ROLE) return;

  const routeKey = buildRouteKeyFromEvent(data);
  if (!routeKey) return;

  const conversationId = extractString(data.conversationId);
  if (!conversationId) return;

  const index = await readIndexFile();
  const existing = index.entries[routeKey];

  // Only update if this event is newer (or first entry).
  if (existing && existing.timestamp > event.ts) return;

  index.entries[routeKey] = {
    conversationId,
    timestamp: event.ts,
    lastEventType: event.type as A2AConversationEntry["lastEventType"],
    runId: extractString(data.runId),
  };
  index.updatedAt = Date.now();

  await writeIndexFile(index);
}

function onA2AEvent(event: CoordinationEvent): void {
  if (!indexFilePath) return;
  writeQueue = writeQueue.then(() => updateIndex(event)).catch((err) => {
    log.warn("a2a-index write failed", { error: String(err) });
  });
}

// --- Public API (module-level, matching event-log.ts pattern) ---

/**
 * Start the A2A conversation index writer.
 * Subscribes to `a2a.send`, `a2a.response`, `a2a.complete` events on the bus
 * and maintains `a2a-conversation-index.json` in `stateDir`.
 */
export function startA2AIndex(stateDir: string): void {
  if (indexFilePath) return; // already started

  fs.mkdirSync(stateDir, { recursive: true });
  indexFilePath = path.join(stateDir, INDEX_FILENAME);

  for (const type of A2A_EVENT_TYPES) {
    unsubscribes.push(subscribe(type, onA2AEvent));
  }
}

/**
 * Stop the A2A index writer and drain pending writes.
 */
export async function stopA2AIndex(): Promise<void> {
  for (const unsub of unsubscribes) {
    unsub();
  }
  unsubscribes = [];

  // Drain pending writes before resetting state.
  await writeQueue;

  indexFilePath = null;
  writeQueue = Promise.resolve();
}

/**
 * Drain the write queue without stopping subscriptions.
 * Useful in tests to ensure all pending writes are flushed.
 */
export async function flushA2AIndex(): Promise<void> {
  await writeQueue;
}

/**
 * O(1) lookup: read the latest conversationId for a routeKey from the index file.
 * Returns `undefined` if the index is unavailable or the routeKey is not found.
 */
export async function getA2AConversationId(routeKey: string): Promise<string | undefined> {
  if (!indexFilePath) return undefined;
  try {
    const raw = await fsp.readFile(indexFilePath, "utf-8");
    const index = JSON.parse(raw) as A2AConversationIndex;
    return index.entries[routeKey]?.conversationId;
  } catch {
    return undefined;
  }
}

/**
 * Return the full index (diagnostic / debugging use).
 */
export async function getA2AIndex(): Promise<A2AConversationIndex | null> {
  if (!indexFilePath) return null;
  try {
    const raw = await fsp.readFile(indexFilePath, "utf-8");
    return JSON.parse(raw) as A2AConversationIndex;
  } catch {
    return null;
  }
}
