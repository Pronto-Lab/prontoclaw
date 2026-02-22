/**
 * EventBus → Task-Hub Dashboard Sink
 *
 * Subscribes to A2A events and forwards collaboration messages to the
 * task-hub dashboard when a topicId is present. Only "conversation.main"
 * events are forwarded to avoid noisy subagent delegation chatter.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { subscribe, type CoordinationEvent } from "./bus.js";
import { EVENT_TYPES } from "./schemas.js";

const log = createSubsystemLogger("task-hub-sink");

const A2A_FORWARD_TYPES = new Set([EVENT_TYPES.A2A_SEND, EVENT_TYPES.A2A_RESPONSE]);
const CONVERSATION_MAIN_ROLE = "conversation.main";

interface TaskHubPayload {
  agentId: string;
  message: string;
  topicId: string;
  conversationId?: string;
  severity: "info";
}

function buildPayload(event: CoordinationEvent): TaskHubPayload | null {
  const data = event.data ?? {};

  if (!A2A_FORWARD_TYPES.has(event.type)) {
    return null;
  }

  const topicId = typeof data.topicId === "string" ? data.topicId.trim() : "";
  if (!topicId) {
    return null;
  }

  const eventRole = typeof data.eventRole === "string" ? data.eventRole : "";
  if (eventRole !== CONVERSATION_MAIN_ROLE) {
    return null;
  }

  const fromAgent = typeof data.fromAgent === "string" ? data.fromAgent : "unknown";
  const toAgent = typeof data.toAgent === "string" ? data.toAgent : "unknown";
  const message = typeof data.message === "string" ? data.message : "";

  const label =
    event.type === EVENT_TYPES.A2A_SEND
      ? `[${fromAgent} → ${toAgent}]`
      : `[${fromAgent} ← ${toAgent}]`;

  return {
    agentId: fromAgent,
    message: `${label} ${message}`.slice(0, 4000),
    topicId,
    conversationId: typeof data.conversationId === "string" ? data.conversationId : undefined,
    severity: "info",
  };
}

async function postToTaskHub(
  baseUrl: string,
  token: string,
  payload: TaskHubPayload,
): Promise<void> {
  try {
    const resp = await fetch(`${baseUrl}/api/dm/incoming`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": token,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      log.warn("task-hub POST failed", { status: resp.status, topicId: payload.topicId });
    }
  } catch (err) {
    log.warn("task-hub POST error", { error: String(err) });
  }
}

export function startTaskHubSink(): (() => void) | null {
  const baseUrl = process.env.TASK_HUB_URL?.replace(/\/+$/, "");
  const token = process.env.INTERNAL_API_TOKEN;

  if (!baseUrl || !token) {
    log.warn("TASK_HUB_URL or INTERNAL_API_TOKEN not set, sink disabled");
    return null;
  }

  let stopped = false;

  const unsubscribes = [...A2A_FORWARD_TYPES].map((type) =>
    subscribe(type, (event) => {
      if (stopped) {
        return;
      }
      const payload = buildPayload(event);
      if (payload) {
        void postToTaskHub(baseUrl, token, payload);
      }
    }),
  );

  log.warn("task-hub sink started", { baseUrl });

  return () => {
    stopped = true;
    for (const unsub of unsubscribes) {
      unsub();
    }
  };
}
