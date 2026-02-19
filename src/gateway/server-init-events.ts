import { registerSkillsChangeListener } from "../agents/skills/refresh.js";
import { clearAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { startHeartbeatRunner, type HeartbeatRunner } from "../infra/heartbeat-runner.js";
import {
  primeRemoteSkillsCache,
  refreshRemoteBinsForConnectedNodes,
  setSkillsRemoteRegistry,
} from "../infra/skills-remote.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import type { NodeRegistry } from "./node-registry.js";
import { createAgentEventHandler } from "./server-chat.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";

export type GatewayEventsState = {
  skillsChangeUnsub: () => void;
  clearSkillsRefreshTimer: () => void;
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  agentUnsub: (() => void) | null;
  heartbeatUnsub: (() => void) | null;
  heartbeatRunner: HeartbeatRunner;
};

export function initGatewayEvents(opts: {
  cfg: OpenClawConfig;
  minimalTestGateway: boolean;
  nodeRegistry: NodeRegistry;
  broadcast: Parameters<typeof createAgentEventHandler>[0]["broadcast"];
  broadcastToConnIds: Parameters<typeof createAgentEventHandler>[0]["broadcastToConnIds"];
  nodeSendToSession: Parameters<typeof createAgentEventHandler>[0]["nodeSendToSession"];
  nodeSendToAllSubscribed: Parameters<typeof startGatewayMaintenanceTimers>[0]["nodeSendToAllSubscribed"];
  agentRunSeq: Parameters<typeof createAgentEventHandler>[0]["agentRunSeq"];
  chatRunState: Parameters<typeof createAgentEventHandler>[0]["chatRunState"];
  chatRunBuffers: Parameters<typeof startGatewayMaintenanceTimers>[0]["chatRunBuffers"];
  chatDeltaSentAt: Parameters<typeof startGatewayMaintenanceTimers>[0]["chatDeltaSentAt"];
  removeChatRun: Parameters<typeof startGatewayMaintenanceTimers>[0]["removeChatRun"];
  chatAbortControllers: Parameters<typeof startGatewayMaintenanceTimers>[0]["chatAbortControllers"];
  toolEventRecipients: Parameters<typeof createAgentEventHandler>[0]["toolEventRecipients"];
  dedupe: Parameters<typeof startGatewayMaintenanceTimers>[0]["dedupe"];
  getPresenceVersion: Parameters<typeof startGatewayMaintenanceTimers>[0]["getPresenceVersion"];
  getHealthVersion: Parameters<typeof startGatewayMaintenanceTimers>[0]["getHealthVersion"];
  refreshGatewayHealthSnapshot: Parameters<typeof startGatewayMaintenanceTimers>[0]["refreshGatewayHealthSnapshot"];
  logHealth: Parameters<typeof startGatewayMaintenanceTimers>[0]["logHealth"];
  resolveSessionKeyForRun: Parameters<typeof createAgentEventHandler>[0]["resolveSessionKeyForRun"];
}): GatewayEventsState {
  if (!opts.minimalTestGateway) {
    setSkillsRemoteRegistry(opts.nodeRegistry);
    void primeRemoteSkillsCache();
  }

  let skillsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const skillsRefreshDelayMs = 30_000;
  const skillsChangeUnsub = opts.minimalTestGateway
    ? () => {}
    : registerSkillsChangeListener((event) => {
        if (event.reason === "remote-node") {
          return;
        }
        if (skillsRefreshTimer) {
          clearTimeout(skillsRefreshTimer);
        }
        skillsRefreshTimer = setTimeout(() => {
          skillsRefreshTimer = null;
          const latest = loadConfig();
          void refreshRemoteBinsForConnectedNodes(latest);
        }, skillsRefreshDelayMs);
      });

  const clearSkillsRefreshTimer = () => {
    if (skillsRefreshTimer) {
      clearTimeout(skillsRefreshTimer);
      skillsRefreshTimer = null;
    }
  };

  const noopInterval = () => setInterval(() => {}, 1 << 30);
  let tickInterval = noopInterval();
  let healthInterval = noopInterval();
  let dedupeCleanup = noopInterval();
  if (!opts.minimalTestGateway) {
    ({ tickInterval, healthInterval, dedupeCleanup } = startGatewayMaintenanceTimers({
      broadcast: opts.broadcast,
      nodeSendToAllSubscribed: opts.nodeSendToAllSubscribed,
      getPresenceVersion: opts.getPresenceVersion,
      getHealthVersion: opts.getHealthVersion,
      refreshGatewayHealthSnapshot: opts.refreshGatewayHealthSnapshot,
      logHealth: opts.logHealth,
      dedupe: opts.dedupe,
      chatAbortControllers: opts.chatAbortControllers,
      chatRunState: opts.chatRunState,
      chatRunBuffers: opts.chatRunBuffers,
      chatDeltaSentAt: opts.chatDeltaSentAt,
      removeChatRun: opts.removeChatRun,
      agentRunSeq: opts.agentRunSeq,
      nodeSendToSession: opts.nodeSendToSession,
    }));
  }

  const agentUnsub = opts.minimalTestGateway
    ? null
    : onAgentEvent(
        createAgentEventHandler({
          broadcast: opts.broadcast,
          broadcastToConnIds: opts.broadcastToConnIds,
          nodeSendToSession: opts.nodeSendToSession,
          agentRunSeq: opts.agentRunSeq,
          chatRunState: opts.chatRunState,
          resolveSessionKeyForRun: opts.resolveSessionKeyForRun,
          clearAgentRunContext,
          toolEventRecipients: opts.toolEventRecipients,
        }),
      );

  const heartbeatUnsub = opts.minimalTestGateway
    ? null
    : onHeartbeatEvent((evt) => {
        opts.broadcast("heartbeat", evt, { dropIfSlow: true });
      });

  const heartbeatRunner: HeartbeatRunner = opts.minimalTestGateway
    ? {
        stop: () => {},
        updateConfig: () => {},
      }
    : startHeartbeatRunner({ cfg: opts.cfg });

  return {
    skillsChangeUnsub,
    clearSkillsRefreshTimer,
    tickInterval,
    healthInterval,
    dedupeCleanup,
    agentUnsub,
    heartbeatUnsub,
    heartbeatRunner,
  };
}
