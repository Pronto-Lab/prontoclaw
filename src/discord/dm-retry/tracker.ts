import JSON5 from "json5";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";

export type TrackedDmStatus = "pending" | "responded" | "failed";

export interface TrackedDm {
  id: string;
  messageId: string;
  channelId: string;
  senderAgentId: string;
  targetUserId: string;
  originalText: string;
  sentAt: number;
  attempts: number;
  lastAttemptAt: number;
  status: TrackedDmStatus;
}

export interface DmRetryStore {
  version: number;
  tracked: Record<string, TrackedDm>;
}

const STORE_VERSION = 1;
const STORE_FILENAME = "dm-retry-tracking.json";

function getStorePath(): string {
  return path.join(resolveStateDir(), STORE_FILENAME);
}

function createEmptyStore(): DmRetryStore {
  return { version: STORE_VERSION, tracked: {} };
}

function isValidStore(value: unknown): value is DmRetryStore {
  return (
    !!value &&
    typeof value === "object" &&
    "version" in value &&
    "tracked" in value &&
    typeof (value as DmRetryStore).tracked === "object"
  );
}

export function loadDmRetryStore(): DmRetryStore {
  const storePath = getStorePath();
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (isValidStore(parsed)) {
      return parsed;
    }
    return createEmptyStore();
  } catch {
    return createEmptyStore();
  }
}

async function saveDmRetryStore(store: DmRetryStore): Promise<void> {
  const storePath = getStorePath();
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);
  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fs.promises.rename(tmp, storePath);
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function trackOutboundDm(params: {
  messageId: string;
  channelId: string;
  senderAgentId: string;
  targetUserId: string;
  originalText: string;
}): Promise<TrackedDm> {
  const store = loadDmRetryStore();
  const now = Date.now();
  const dm: TrackedDm = {
    id: crypto.randomUUID(),
    messageId: params.messageId,
    channelId: params.channelId,
    senderAgentId: params.senderAgentId,
    targetUserId: params.targetUserId,
    originalText: params.originalText,
    sentAt: now,
    attempts: 1,
    lastAttemptAt: now,
    status: "pending",
  };
  store.tracked[dm.id] = dm;
  await saveDmRetryStore(store);
  return dm;
}

export async function markDmResponded(channelId: string): Promise<number> {
  const store = loadDmRetryStore();
  let count = 0;
  for (const dm of Object.values(store.tracked)) {
    if (dm.channelId === channelId && dm.status === "pending") {
      dm.status = "responded";
      count++;
    }
  }
  if (count > 0) {
    await saveDmRetryStore(store);
  }
  return count;
}

export function getTimedOutDms(timeoutMs: number): TrackedDm[] {
  const store = loadDmRetryStore();
  const now = Date.now();
  return Object.values(store.tracked).filter(
    (dm) => dm.status === "pending" && now - dm.lastAttemptAt >= timeoutMs,
  );
}

export async function incrementRetryAttempt(id: string): Promise<TrackedDm | null> {
  const store = loadDmRetryStore();
  const dm = store.tracked[id];
  if (!dm) {
    return null;
  }
  dm.attempts += 1;
  dm.lastAttemptAt = Date.now();
  await saveDmRetryStore(store);
  return dm;
}

export async function markDmFailed(id: string): Promise<TrackedDm | null> {
  const store = loadDmRetryStore();
  const dm = store.tracked[id];
  if (!dm) {
    return null;
  }
  dm.status = "failed";
  await saveDmRetryStore(store);
  return dm;
}

export async function cleanupOldEntries(maxAgeMs: number): Promise<number> {
  const store = loadDmRetryStore();
  const now = Date.now();
  let count = 0;
  for (const [id, dm] of Object.entries(store.tracked)) {
    if (dm.status !== "pending" && now - dm.lastAttemptAt > maxAgeMs) {
      delete store.tracked[id];
      count++;
    }
  }
  if (count > 0) {
    await saveDmRetryStore(store);
  }
  return count;
}
