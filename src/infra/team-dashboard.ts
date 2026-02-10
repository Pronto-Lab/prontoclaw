/**
 * Team State → Discord Dashboard
 *
 * Periodically reads the TeamState and posts/edits a summary embed to a
 * Discord webhook.  The embed shows each agent's status, current task,
 * and last activity time — a live operational dashboard for multi-agent
 * deployments.
 */

import { readTeamState, type AgentTeamEntry } from "./team-state.js";

export type TeamDashboardConfig = {
  /** Discord webhook URL for the dashboard embed. */
  webhookUrl: string;
  /** Workspace directory for reading team state. */
  workspaceDir: string;
  /** Refresh interval in ms (default: 30_000). */
  intervalMs?: number;
};

const STATUS_EMOJI: Record<string, string> = {
  active: "🟢",
  idle: "🟡",
  interrupted: "🔴",
  blocked: "🔴",
  offline: "⚫",
};

function formatAgentField(agentId: string, entry: AgentTeamEntry) {
  const emoji = STATUS_EMOJI[entry.status] ?? "⚪";
  const lastMs = entry.lastActivityMs ?? 0;
  const ago = lastMs > 0 ? `${Math.round((Date.now() - lastMs) / 60_000)}m ago` : "unknown";
  const task = entry.currentTaskId ? `\`${entry.currentTaskId}\`` : "—";
  const failure = entry.lastFailureReason ? ` ⚠ ${entry.lastFailureReason}` : "";

  return {
    name: `${emoji} ${agentId}`,
    value: `Status: **${entry.status}** | Task: ${task} | Active: ${ago}${failure}`,
    inline: false,
  };
}

function buildDashboardEmbed(agents: Record<string, AgentTeamEntry>) {
  const entries = Object.entries(agents);
  const fields = entries.map(([id, entry]) => formatAgentField(id, entry));
  const activeCount = entries.filter(([, e]) => e.status === "active").length;

  return {
    title: "🤖 Agent Team Dashboard",
    color: activeCount > 0 ? 0x2ecc71 : 0x95a5a6,
    description: `${entries.length} agent(s) registered, ${activeCount} active`,
    fields: fields.slice(0, 25),
    timestamp: new Date().toISOString(),
    footer: { text: "Auto-updated by team-dashboard" },
  };
}

async function postOrEditDashboard(
  webhookUrl: string,
  embed: ReturnType<typeof buildDashboardEmbed>,
  messageId: string | null,
): Promise<string | null> {
  try {
    if (messageId) {
      // Try to edit existing message
      const editUrl = `${webhookUrl}/messages/${messageId}`;
      const resp = await fetch(editUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (resp.ok) {
        return messageId;
      }
      // If edit fails (message deleted), fall through to create new
    }

    // Create new message
    const resp = await fetch(`${webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { id?: string };
      return data.id ?? null;
    }
  } catch {
    // Swallow errors — dashboard is best-effort
  }
  return null;
}

export function startTeamDashboard(config: TeamDashboardConfig): () => void {
  const interval = config.intervalMs ?? 30_000;
  let messageId: string | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick() {
    if (stopped) {
      return;
    }
    try {
      const state = await readTeamState(config.workspaceDir);
      const embed = buildDashboardEmbed(state?.agents ?? {});
      messageId = await postOrEditDashboard(config.webhookUrl, embed, messageId);
    } catch {
      // Ignore — next tick will retry
    }
    if (!stopped) {
      timer = setTimeout(tick, interval);
    }
  }

  // Start first tick immediately
  void tick();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
