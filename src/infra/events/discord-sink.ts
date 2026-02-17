/**
 * EventBus → Discord Webhook Sink
 *
 * Subscribes to the EventBus and forwards events to a Discord webhook as
 * batched, color-coded embeds.  Designed for operational monitoring of
 * multi-agent task activity without polluting regular chat channels.
 */

import { subscribe, type CoordinationEvent } from "./bus.js";
import { EVENT_TYPES, type EventType } from "./schemas.js";

export type DiscordSinkConfig = {
  /** Discord webhook URL for monitor events. */
  webhookUrl: string;
  /** Only forward these event types (default: all). */
  eventFilter?: EventType[];
  /** Batching window in ms (default: 5000). */
  batchWindowMs?: number;
  /** Max events per batch before force-flush (default: 10). */
  maxBatchSize?: number;
};

const EVENT_COLORS: Partial<Record<EventType, number>> = {
  [EVENT_TYPES.TASK_STARTED]: 0x2ecc71, // green
  [EVENT_TYPES.TASK_COMPLETED]: 0x3498db, // blue
  [EVENT_TYPES.TASK_CANCELLED]: 0xe67e22, // orange
  [EVENT_TYPES.TASK_BLOCKED]: 0xe74c3c, // red
  [EVENT_TYPES.TASK_APPROVED]: 0x9b59b6, // purple
  [EVENT_TYPES.TASK_RESUMED]: 0x1abc9c, // teal
  [EVENT_TYPES.ZOMBIE_ABANDONED]: 0x95a5a6, // grey
  [EVENT_TYPES.CONTINUATION_BACKOFF]: 0xf39c12, // yellow
  [EVENT_TYPES.UNBLOCK_REQUESTED]: 0xe74c3c, // red
  [EVENT_TYPES.PLAN_SUBMITTED]: 0x3498db, // blue
  [EVENT_TYPES.PLAN_APPROVED]: 0x2ecc71, // green
  [EVENT_TYPES.PLAN_REJECTED]: 0xe74c3c, // red
};

function formatEmbed(event: CoordinationEvent) {
  const color = EVENT_COLORS[event.type as EventType] ?? 0x95a5a6;
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];

  if (event.agentId) {
    fields.push({ name: "Agent", value: event.agentId, inline: true });
  }
  if (event.data) {
    for (const [key, value] of Object.entries(event.data)) {
      if (value !== undefined && value !== null) {
        fields.push({
          name: key,
          value: (typeof value === "object"
            ? JSON.stringify(value)
            : String(value as string | number | boolean)
          ).slice(0, 256),
          inline: true,
        });
      }
    }
  }

  return {
    title: event.type,
    color,
    fields: fields.slice(0, 25), // Discord embed field limit
    timestamp: new Date(event.ts).toISOString(),
  };
}

async function sendWebhook(
  webhookUrl: string,
  embeds: ReturnType<typeof formatEmbed>[],
): Promise<void> {
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: embeds.slice(0, 10) }), // Discord max 10 embeds
    });
    if (!resp.ok && resp.status === 429) {
      const retryAfter = Number(resp.headers.get("retry-after") || "5") * 1000;
      await new Promise((r) => setTimeout(r, retryAfter));
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: embeds.slice(0, 10) }),
      });
    }
  } catch {
    // Swallow webhook errors — monitoring should never break the system
  }
}

export function startDiscordSink(config: DiscordSinkConfig): () => void {
  const batchWindow = config.batchWindowMs ?? 5000;
  const maxBatch = config.maxBatchSize ?? 10;
  const filterSet = config.eventFilter ? new Set<string>(config.eventFilter) : null;

  let queue: CoordinationEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function flush() {
    if (queue.length === 0) {
      return;
    }
    const batch = queue.splice(0, maxBatch);
    const embeds = batch.map(formatEmbed);
    void sendWebhook(config.webhookUrl, embeds);
  }

  function scheduleFlush() {
    if (timer || stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      flush();
      if (queue.length > 0) {
        scheduleFlush();
      }
    }, batchWindow);
  }

  const unsubscribe = subscribe("*", (event) => {
    if (stopped) {
      return;
    }
    if (filterSet && !filterSet.has(event.type)) {
      return;
    }
    queue.push(event);
    if (queue.length >= maxBatch) {
      flush();
    } else {
      scheduleFlush();
    }
  });

  return () => {
    stopped = true;
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush(); // Final flush
  };
}
