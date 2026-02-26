import type { OpenClawConfig } from "../../config/config.js";

export type A2aRetryResolvedConfig = {
  enabled: boolean;
  responseTimeoutMs: number;
  maxAttempts: number;
  checkIntervalMs: number;
  cleanupMaxAgeMs: number;
  escalationMentionId?: string;
  notifyOnFailure: boolean;
};

const A2A_RETRY_DEFAULTS: A2aRetryResolvedConfig = {
  enabled: false,
  responseTimeoutMs: 300_000,
  maxAttempts: 3,
  checkIntervalMs: 60_000,
  cleanupMaxAgeMs: 86_400_000,
  notifyOnFailure: true,
};

export function resolveA2aRetryConfig(
  cfg: OpenClawConfig,
  accountId?: string,
): A2aRetryResolvedConfig {
  const discordCfg = (cfg as Record<string, unknown>).discord as
    | Record<string, unknown>
    | undefined;
  const accountCfg = accountId
    ? ((discordCfg?.accounts as Record<string, unknown> | undefined)?.[accountId] as
        | Record<string, unknown>
        | undefined)
    : undefined;
  const a2aRetry = (accountCfg?.a2aRetry ?? discordCfg?.a2aRetry) as
    | Partial<A2aRetryResolvedConfig>
    | undefined;

  return {
    enabled: a2aRetry?.enabled ?? A2A_RETRY_DEFAULTS.enabled,
    responseTimeoutMs: a2aRetry?.responseTimeoutMs ?? A2A_RETRY_DEFAULTS.responseTimeoutMs,
    maxAttempts: a2aRetry?.maxAttempts ?? A2A_RETRY_DEFAULTS.maxAttempts,
    checkIntervalMs: a2aRetry?.checkIntervalMs ?? A2A_RETRY_DEFAULTS.checkIntervalMs,
    cleanupMaxAgeMs: a2aRetry?.cleanupMaxAgeMs ?? A2A_RETRY_DEFAULTS.cleanupMaxAgeMs,
    escalationMentionId: a2aRetry?.escalationMentionId,
    notifyOnFailure: a2aRetry?.notifyOnFailure ?? A2A_RETRY_DEFAULTS.notifyOnFailure,
  };
}

export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen - 3) + "...";
}
