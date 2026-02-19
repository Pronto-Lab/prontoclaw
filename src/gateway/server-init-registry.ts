import { initSubagentRegistry } from "../agents/subagent-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { NodeRegistry } from "./node-registry.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";
import { safeParseJson } from "./server-methods/nodes.helpers.js";

export type GatewayRegistryState = {
  nodeRegistry: NodeRegistry;
  nodePresenceTimers: Map<string, ReturnType<typeof setInterval>>;
  nodeSendEvent: (opts: { nodeId: string; event: string; payloadJSON?: string | null }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  nodeSubscribe: ReturnType<typeof createNodeSubscriptionManager>["subscribe"];
  nodeUnsubscribe: ReturnType<typeof createNodeSubscriptionManager>["unsubscribe"];
  nodeUnsubscribeAll: ReturnType<typeof createNodeSubscriptionManager>["unsubscribeAll"];
};

/**
 * Initialize node registry, subscription manager, and associated helpers.
 * Also applies lane concurrency from config.
 */
export function initGatewayRegistry(cfg: OpenClawConfig): GatewayRegistryState {
  initSubagentRegistry();

  const nodeRegistry = new NodeRegistry();
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();
  const nodeSubscriptions = createNodeSubscriptionManager();

  const nodeSendEvent = (opts: { nodeId: string; event: string; payloadJSON?: string | null }) => {
    const payload = safeParseJson(opts.payloadJSON ?? null);
    nodeRegistry.sendEvent(opts.nodeId, opts.event, payload);
  };
  const nodeSendToSession = (sessionKey: string, event: string, payload: unknown) =>
    nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
  const nodeSendToAllSubscribed = (event: string, payload: unknown) =>
    nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);

  applyGatewayLaneConcurrency(cfg);

  return {
    nodeRegistry,
    nodePresenceTimers,
    nodeSendEvent,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe: nodeSubscriptions.subscribe,
    nodeUnsubscribe: nodeSubscriptions.unsubscribe,
    nodeUnsubscribeAll: nodeSubscriptions.unsubscribeAll,
  };
}
