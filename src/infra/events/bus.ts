import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("event-bus");

export type CoordinationEvent = {
  type: string;
  agentId: string;
  ts: number;
  data: Record<string, unknown>;
};

type EventListener = (event: CoordinationEvent) => void;

const listeners = new Map<string, Set<EventListener>>();
const wildcardListeners = new Set<EventListener>();

export function emit(event: CoordinationEvent): void {
  const typeListeners = listeners.get(event.type);
  if (typeListeners) {
    for (const fn of typeListeners) {
      try {
        fn(event);
      } catch (err) {
        log.warn("Event listener error", { type: event.type, error: String(err) });
      }
    }
  }
  for (const fn of wildcardListeners) {
    try {
      fn(event);
    } catch (err) {
      log.warn("Wildcard listener error", { type: event.type, error: String(err) });
    }
  }
}

export function subscribe(type: string, fn: EventListener): () => void {
  if (type === "*") {
    wildcardListeners.add(fn);
    return () => wildcardListeners.delete(fn);
  }
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) {
      listeners.delete(type);
    }
  };
}

export function reset(): void {
  listeners.clear();
  wildcardListeners.clear();
}
