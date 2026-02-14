/**
 * Agent-to-Agent Loop Guard
 *
 * Detects and prevents infinite message loops between agents by tracking:
 * 1. Self-message filter: blocks messages where author's applicationId matches our own
 * 2. Rate guard: sliding-window rate limiter per A2A channel pair
 * 3. Depth cap: maximum A2A relay depth to prevent deep recursion
 */

export type LoopGuardConfig = {
  /** Max messages per window before throttling (default: 10). */
  maxMessagesPerWindow?: number;
  /** Sliding window duration in ms (default: 60_000). */
  windowMs?: number;
  /** Maximum A2A relay depth (default: 5). */
  maxDepth?: number;
  /** Per-pair overrides keyed by "agentA::agentB" (alphabetically sorted). */
  overrides?: Record<string, Omit<LoopGuardConfig, "overrides">>;
};

type ChannelWindow = {
  timestamps: number[];
};

const windows = new Map<string, ChannelWindow>();
const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_DEPTH = 5;

function channelKey(fromId: string, toId: string): string {
  // Ordered pair so A→B and B→A share the same bucket
  return fromId < toId ? `${fromId}::${toId}` : `${toId}::${fromId}`;
}

function getWindow(key: string): ChannelWindow {
  let w = windows.get(key);
  if (!w) {
    w = { timestamps: [] };
    windows.set(key, w);
  }
  return w;
}

function pruneWindow(w: ChannelWindow, now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  while (w.timestamps.length > 0 && w.timestamps[0] < cutoff) {
    w.timestamps.shift();
  }
}

/**
 * Check if a message is a self-message (our own applicationId).
 * Should be called before the standard bot filter.
 */
export function isSelfMessage(
  authorApplicationId: string | undefined,
  ourApplicationId: string | undefined,
): boolean {
  if (!authorApplicationId || !ourApplicationId) {
    return false;
  }
  return authorApplicationId === ourApplicationId;
}

/**
 * Record an A2A message and check if the rate limit is exceeded.
 * Returns true if the message should be BLOCKED (rate exceeded).
 */
export function checkA2ARateLimit(fromId: string, toId: string, config?: LoopGuardConfig): boolean {
  const key = channelKey(fromId, toId);
  const pairConfig = config?.overrides?.[key];
  const maxMessages =
    pairConfig?.maxMessagesPerWindow ?? config?.maxMessagesPerWindow ?? DEFAULT_MAX_MESSAGES;
  const windowMs = pairConfig?.windowMs ?? config?.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();

  const w = getWindow(key);
  pruneWindow(w, now, windowMs);

  if (w.timestamps.length >= maxMessages) {
    return true; // blocked
  }

  w.timestamps.push(now);
  return false; // allowed
}

/**
 * Check if A2A depth exceeds maximum.
 * Returns true if the message should be BLOCKED (depth exceeded).
 */
export function checkA2ADepthLimit(currentDepth: number, config?: LoopGuardConfig): boolean {
  const maxDepth = config?.maxDepth ?? DEFAULT_MAX_DEPTH;
  return currentDepth > maxDepth;
}

/** Clear all windows (for tests). */
export function resetLoopGuard(): void {
  windows.clear();
}
