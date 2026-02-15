import { type QueueDropPolicy, type QueueMode } from "../auto-reply/reply/queue.js";
import { defaultRuntime } from "../runtime.js";
import {
  type DeliveryContext,
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import {
  applyQueueDropPolicy,
  buildCollectPrompt,
  buildQueueSummaryPrompt,
  hasCrossChannelItems,
  waitForQueueDebounce,
} from "../utils/queue-helpers.js";

export type AnnounceQueueItem = {
  prompt: string;
  summaryLine?: string;
  enqueuedAt: number;
  sessionKey: string;
  origin?: DeliveryContext;
  originKey?: string;
  /** High priority items bypass stale-age dropping. */
  highPriority?: boolean;
};

export type AnnounceQueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
  maxAgeMs?: number;
};

type AnnounceQueueState = {
  items: AnnounceQueueItem[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  send: (item: AnnounceQueueItem) => Promise<void>;
  maxAgeMs: number;
};

const ANNOUNCE_QUEUES = new Map<string, AnnounceQueueState>();

function previewQueueSummaryPrompt(queue: AnnounceQueueState): string | undefined {
  return buildQueueSummaryPrompt({
    state: {
      dropPolicy: queue.dropPolicy,
      droppedCount: queue.droppedCount,
      summaryLines: [...queue.summaryLines],
    },
    noun: "announce",
  });
}

function clearQueueSummaryState(queue: AnnounceQueueState) {
  queue.droppedCount = 0;
  queue.summaryLines.length = 0;
}

function isStaleItem(queue: AnnounceQueueState, item: AnnounceQueueItem, now = Date.now()) {
  if (item.highPriority) {
    return false;
  }
  if (!Number.isFinite(queue.maxAgeMs) || queue.maxAgeMs <= 0) {
    return false;
  }
  return now - item.enqueuedAt > queue.maxAgeMs;
}

function getAnnounceQueue(
  key: string,
  settings: AnnounceQueueSettings,
  send: (item: AnnounceQueueItem) => Promise<void>,
) {
  const existing = ANNOUNCE_QUEUES.get(key);
  if (existing) {
    existing.mode = settings.mode;
    existing.debounceMs =
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : existing.debounceMs;
    existing.cap =
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : existing.cap;
    existing.dropPolicy = settings.dropPolicy ?? existing.dropPolicy;
    existing.maxAgeMs =
      typeof settings.maxAgeMs === "number" && Number.isFinite(settings.maxAgeMs)
        ? Math.max(0, Math.floor(settings.maxAgeMs))
        : existing.maxAgeMs;
    existing.send = send;
    return existing;
  }
  const created: AnnounceQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs: typeof settings.debounceMs === "number" ? Math.max(0, settings.debounceMs) : 1000,
    cap: typeof settings.cap === "number" && settings.cap > 0 ? Math.floor(settings.cap) : 20,
    dropPolicy: settings.dropPolicy ?? "summarize",
    droppedCount: 0,
    summaryLines: [],
    send,
    maxAgeMs:
      typeof settings.maxAgeMs === "number" && Number.isFinite(settings.maxAgeMs)
        ? Math.max(0, Math.floor(settings.maxAgeMs))
        : 10 * 60 * 1000,
  };
  ANNOUNCE_QUEUES.set(key, created);
  return created;
}

async function sendIfFresh(queue: AnnounceQueueState, key: string, item: AnnounceQueueItem) {
  if (isStaleItem(queue, item)) {
    defaultRuntime.log?.(`announce stale dropped for ${key}`);
    return;
  }
  await queue.send(item);
}

function scheduleAnnounceDrain(key: string) {
  const queue = ANNOUNCE_QUEUES.get(key);
  if (!queue || queue.draining) {
    return;
  }
  queue.draining = true;
  void (async () => {
    try {
      let forceIndividualCollect = false;
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
        if (queue.mode === "collect") {
          if (forceIndividualCollect) {
            const next = queue.items[0];
            if (!next) {
              break;
            }
            await sendIfFresh(queue, key, next);
            queue.items.shift();
            continue;
          }
          const isCrossChannel = hasCrossChannelItems(queue.items, (item) => {
            if (!item.origin) {
              return {};
            }
            if (!item.originKey) {
              return { cross: true };
            }
            return { key: item.originKey };
          });
          if (isCrossChannel) {
            forceIndividualCollect = true;
            const next = queue.items[0];
            if (!next) {
              break;
            }
            await sendIfFresh(queue, key, next);
            queue.items.shift();
            continue;
          }
          const items = queue.items.slice();
          const summary = previewQueueSummaryPrompt(queue);
          const prompt = buildCollectPrompt({
            title: "[Queued announce messages while agent was busy]",
            items,
            summary,
            renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
          });
          const last = items.at(-1);
          if (!last) {
            break;
          }
          await sendIfFresh(queue, key, { ...last, prompt });
          queue.items.splice(0, items.length);
          if (summary) {
            clearQueueSummaryState(queue);
          }
          continue;
        }

        const summaryPrompt = previewQueueSummaryPrompt(queue);
        if (summaryPrompt) {
          const next = queue.items[0];
          if (!next) {
            break;
          }
          await sendIfFresh(queue, key, { ...next, prompt: summaryPrompt });
          queue.items.shift();
          clearQueueSummaryState(queue);
          continue;
        }

        const next = queue.items[0];
        if (!next) {
          break;
        }
        await sendIfFresh(queue, key, next);
        queue.items.shift();
      }
    } catch (err) {
      queue.lastEnqueuedAt = Date.now();
      defaultRuntime.error?.(`announce queue drain failed for ${key}: ${String(err)}`);
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        ANNOUNCE_QUEUES.delete(key);
      } else {
        scheduleAnnounceDrain(key);
      }
    }
  })();
}

export function enqueueAnnounce(params: {
  key: string;
  item: AnnounceQueueItem;
  settings: AnnounceQueueSettings;
  send: (item: AnnounceQueueItem) => Promise<void>;
}): boolean {
  const queue = getAnnounceQueue(params.key, params.settings, params.send);
  queue.lastEnqueuedAt = Date.now();

  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
  });
  if (!shouldEnqueue) {
    if (queue.dropPolicy === "new") {
      scheduleAnnounceDrain(params.key);
    }
    return false;
  }

  const origin = normalizeDeliveryContext(params.item.origin);
  const originKey = deliveryContextKey(origin);
  queue.items.push({ ...params.item, origin, originKey });
  scheduleAnnounceDrain(params.key);
  return true;
}

export function resetAnnounceQueuesForTests() {
  for (const queue of ANNOUNCE_QUEUES.values()) {
    queue.items.length = 0;
    queue.summaryLines.length = 0;
    queue.droppedCount = 0;
    queue.lastEnqueuedAt = 0;
    queue.draining = false;
  }
  ANNOUNCE_QUEUES.clear();
}
