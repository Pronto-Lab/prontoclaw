import type { OpenClawConfig } from "../../config/config.js";
import type { DmRetryConfig } from "../../config/types.discord.js";

export const DM_RETRY_DEFAULTS = {
  enabled: false,
  timeoutMs: 300_000,
  maxAttempts: 3,
  backoffMs: 60_000,
  notifyOnFailure: true,
} as const satisfies Required<DmRetryConfig>;

export function resolveDmRetryConfig(
  cfg: OpenClawConfig | undefined,
  accountId?: string,
): Required<DmRetryConfig> {
  const discordCfg = cfg?.channels?.discord;
  const accountCfg = accountId ? discordCfg?.accounts?.[accountId] : undefined;
  const dmRetry = accountCfg?.dm?.retry ?? discordCfg?.dm?.retry;
  return {
    enabled: dmRetry?.enabled ?? DM_RETRY_DEFAULTS.enabled,
    timeoutMs: dmRetry?.timeoutMs ?? DM_RETRY_DEFAULTS.timeoutMs,
    maxAttempts: dmRetry?.maxAttempts ?? DM_RETRY_DEFAULTS.maxAttempts,
    backoffMs: dmRetry?.backoffMs ?? DM_RETRY_DEFAULTS.backoffMs,
    notifyOnFailure: dmRetry?.notifyOnFailure ?? DM_RETRY_DEFAULTS.notifyOnFailure,
  };
}

export function isAgentBotId(userId: string, cfg: OpenClawConfig | undefined): boolean {
  if (!cfg?.agents?.list) {
    return false;
  }
  const discordCfg = cfg.channels?.discord;
  if (!discordCfg) {
    return false;
  }
  const accountIds = Object.keys(discordCfg.accounts ?? {});
  if (discordCfg.token) {
    accountIds.push("default");
  }
  for (const agentEntry of cfg.agents.list) {
    const agentDiscord = (agentEntry as Record<string, unknown>).discord as
      | { botId?: string }
      | undefined;
    if (agentDiscord?.botId === userId) {
      return true;
    }
  }
  return false;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + "...";
}
