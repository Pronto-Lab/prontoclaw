/**
 * Session reaper — prunes completed ephemeral sessions from the session store.
 *
 * Handles two session types:
 * 1. Cron run sessions: `...:cron:<jobId>:run:<uuid>` — pruned after configurable retention.
 * 2. A2A conversation sessions: `agent:<id>:a2a:<conversationId>` — pruned after TTL,
 *    with a per-agent cap to prevent session explosion.
 */

import type { CronConfig } from "../config/types.cron.js";
import type { Logger } from "./service/state.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { updateSessionStore } from "../config/sessions.js";
import {
  isCronRunSessionKey,
  isA2ASessionKey,
  parseA2ASessionKey,
} from "../sessions/session-key-utils.js";

const DEFAULT_RETENTION_MS = 24 * 3_600_000; // 24 hours

/** Default TTL for completed A2A sessions (1 hour). */
const DEFAULT_A2A_TTL_MS = 60 * 60_000;

/** Default max A2A sessions per agent before oldest are pruned. */
const DEFAULT_A2A_MAX_PER_AGENT = 16;

/** Minimum interval between reaper sweeps (avoid running every timer tick). */
const MIN_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

const lastSweepAtMsByStore = new Map<string, number>();
const lastA2ASweepAtMsByStore = new Map<string, number>();

export function resolveRetentionMs(cronConfig?: CronConfig): number | null {
  if (cronConfig?.sessionRetention === false) {
    return null; // pruning disabled
  }
  const raw = cronConfig?.sessionRetention;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return parseDurationMs(raw.trim(), { defaultUnit: "h" });
    } catch {
      return DEFAULT_RETENTION_MS;
    }
  }
  return DEFAULT_RETENTION_MS;
}

export type ReaperResult = {
  swept: boolean;
  pruned: number;
};

/**
 * Sweep the session store and prune expired cron run sessions.
 * Designed to be called from the cron timer tick — self-throttles via
 * MIN_SWEEP_INTERVAL_MS to avoid excessive I/O.
 *
 * Lock ordering: this function acquires the session-store file lock via
 * `updateSessionStore`. It must be called OUTSIDE of the cron service's
 * own `locked()` section to avoid lock-order inversions. The cron timer
 * calls this after all `locked()` sections have been released.
 */
export async function sweepCronRunSessions(params: {
  cronConfig?: CronConfig;
  /** Resolved path to sessions.json — required. */
  sessionStorePath: string;
  nowMs?: number;
  log: Logger;
  /** Override for testing — skips the min-interval throttle. */
  force?: boolean;
}): Promise<ReaperResult> {
  const now = params.nowMs ?? Date.now();
  const storePath = params.sessionStorePath;
  const lastSweepAtMs = lastSweepAtMsByStore.get(storePath) ?? 0;

  // Throttle: don't sweep more often than every 5 minutes.
  if (!params.force && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, pruned: 0 };
  }

  const retentionMs = resolveRetentionMs(params.cronConfig);
  if (retentionMs === null) {
    lastSweepAtMsByStore.set(storePath, now);
    return { swept: false, pruned: 0 };
  }

  let pruned = 0;
  try {
    await updateSessionStore(storePath, (store) => {
      const cutoff = now - retentionMs;
      for (const key of Object.keys(store)) {
        if (!isCronRunSessionKey(key)) {
          continue;
        }
        const entry = store[key];
        if (!entry) {
          continue;
        }
        const updatedAt = entry.updatedAt ?? 0;
        if (updatedAt < cutoff) {
          delete store[key];
          pruned++;
        }
      }
    });
  } catch (err) {
    params.log.warn({ err: String(err) }, "cron-reaper: failed to sweep session store");
    return { swept: false, pruned: 0 };
  }

  lastSweepAtMsByStore.set(storePath, now);

  if (pruned > 0) {
    params.log.info(
      { pruned, retentionMs },
      `cron-reaper: pruned ${pruned} expired cron run session(s)`,
    );
  }

  return { swept: true, pruned };
}

// ---------------------------------------------------------------------------
// A2A session reaper
// ---------------------------------------------------------------------------

export type A2AReaperConfig = {
  /** TTL for completed A2A sessions (duration string, default unit: minutes). */
  ttl?: string | false;
  /** Max A2A sessions per agent before oldest are evicted. */
  maxPerAgent?: number;
};

/**
 * Sweep the session store and prune expired / excess A2A conversation sessions.
 *
 * Two pruning strategies run in a single pass:
 * 1. **TTL-based**: sessions older than `ttl` (default 1h) are removed.
 * 2. **Cap-based**: if an agent has more than `maxPerAgent` (default 16) A2A
 *    sessions, the oldest sessions beyond the cap are removed.
 */
export async function sweepA2ASessions(params: {
  a2aConfig?: A2AReaperConfig;
  /** Resolved path to sessions.json — required. */
  sessionStorePath: string;
  nowMs?: number;
  log: Logger;
  /** Override for testing — skips the min-interval throttle. */
  force?: boolean;
}): Promise<ReaperResult> {
  const now = params.nowMs ?? Date.now();
  const storePath = params.sessionStorePath;
  const lastSweepAtMs = lastA2ASweepAtMsByStore.get(storePath) ?? 0;

  if (!params.force && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, pruned: 0 };
  }

  const ttlMs = resolveA2ATtlMs(params.a2aConfig);
  if (ttlMs === null) {
    lastA2ASweepAtMsByStore.set(storePath, now);
    return { swept: false, pruned: 0 };
  }

  const maxPerAgent = params.a2aConfig?.maxPerAgent ?? DEFAULT_A2A_MAX_PER_AGENT;

  let pruned = 0;
  try {
    await updateSessionStore(storePath, (store) => {
      const cutoff = now - ttlMs;

      // Collect A2A sessions grouped by agent
      const byAgent = new Map<string, { key: string; updatedAt: number }[]>();

      for (const key of Object.keys(store)) {
        if (!isA2ASessionKey(key)) {
          continue;
        }
        const entry = store[key];
        if (!entry) {
          continue;
        }
        const updatedAt = entry.updatedAt ?? 0;

        // Strategy 1: TTL-based pruning
        if (updatedAt < cutoff) {
          delete store[key];
          pruned++;
          continue;
        }

        // Collect surviving sessions for cap check
        const parsed = parseA2ASessionKey(key);
        if (parsed) {
          const list = byAgent.get(parsed.agentId) ?? [];
          list.push({ key, updatedAt });
          byAgent.set(parsed.agentId, list);
        }
      }

      // Strategy 2: Cap-based pruning (oldest first when over limit)
      for (const [, sessions] of byAgent) {
        if (sessions.length <= maxPerAgent) {
          continue;
        }
        // Sort ascending by updatedAt (oldest first)
        sessions.sort((a, b) => a.updatedAt - b.updatedAt);
        const excess = sessions.length - maxPerAgent;
        for (let i = 0; i < excess; i++) {
          delete store[sessions[i].key];
          pruned++;
        }
      }
    });
  } catch (err) {
    params.log.warn({ err: String(err) }, "a2a-reaper: failed to sweep session store");
    return { swept: false, pruned: 0 };
  }

  lastA2ASweepAtMsByStore.set(storePath, now);

  if (pruned > 0) {
    params.log.info(
      { pruned, ttlMs, maxPerAgent },
      `a2a-reaper: pruned ${pruned} expired/excess A2A session(s)`,
    );
  }

  return { swept: true, pruned };
}

function resolveA2ATtlMs(config?: A2AReaperConfig): number | null {
  if (config?.ttl === false) {
    return null; // pruning disabled
  }
  const raw = config?.ttl;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return parseDurationMs(raw.trim(), { defaultUnit: "m" });
    } catch {
      return DEFAULT_A2A_TTL_MS;
    }
  }
  return DEFAULT_A2A_TTL_MS;
}

/** Reset the throttle timer (for tests). */
export function resetReaperThrottle(): void {
  lastSweepAtMsByStore.clear();
  lastA2ASweepAtMsByStore.clear();
}
