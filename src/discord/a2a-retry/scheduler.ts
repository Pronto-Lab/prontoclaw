import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { sendMessageDiscord } from "../send.outbound.js";
import {
  cleanupOldEntries,
  getTimedOutMentions,
  incrementMentionAttempt,
  markMentionFailed,
  type TrackedMention,
} from "./tracker.js";
import { resolveA2aRetryConfig, truncateText } from "./utils.js";

let retryInterval: ReturnType<typeof setInterval> | null = null;
let configRef: OpenClawConfig | null = null;

const CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function startA2aRetryScheduler(cfg: OpenClawConfig): void {
  const a2aRetryConfig = resolveA2aRetryConfig(cfg);
  if (!a2aRetryConfig.enabled) {
    logVerbose("a2a-retry: scheduler disabled");
    return;
  }

  if (retryInterval) {
    clearInterval(retryInterval);
  }

  configRef = cfg;
  logVerbose("a2a-retry: scheduler started");

  retryInterval = setInterval(() => {
    void processPendingRetries().catch((err) => {
      logVerbose(`a2a-retry: scheduler error: ${String(err)}`);
    });
  }, a2aRetryConfig.checkIntervalMs);
}

export function stopA2aRetryScheduler(): void {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
    configRef = null;
    logVerbose("a2a-retry: scheduler stopped");
  }
}

export function updateA2aRetrySchedulerConfig(cfg: OpenClawConfig): void {
  const wasEnabled = configRef ? resolveA2aRetryConfig(configRef).enabled : false;
  const isEnabled = resolveA2aRetryConfig(cfg).enabled;

  configRef = cfg;

  if (!wasEnabled && isEnabled) {
    startA2aRetryScheduler(cfg);
  } else if (wasEnabled && !isEnabled) {
    stopA2aRetryScheduler();
  }
}

async function processPendingRetries(): Promise<void> {
  if (!configRef) {
    return;
  }

  const a2aRetryConfig = resolveA2aRetryConfig(configRef);
  if (!a2aRetryConfig.enabled) {
    return;
  }

  await cleanupOldEntries(CLEANUP_MAX_AGE_MS);

  const timedOut = getTimedOutMentions(a2aRetryConfig.responseTimeoutMs);
  if (timedOut.length === 0) {
    return;
  }

  logVerbose(`a2a-retry: processing ${timedOut.length} timed-out mentions`);

  for (const mention of timedOut) {
    try {
      if (mention.attempts >= a2aRetryConfig.maxAttempts) {
        await markMentionFailed(mention.id);
        if (a2aRetryConfig.notifyOnFailure) {
          await sendEscalation(
            mention,
            a2aRetryConfig.maxAttempts,
            a2aRetryConfig.escalationMentionId,
          );
        }
        logVerbose(
          `a2a-retry: mention ${mention.id} marked failed after ${mention.attempts} attempts`,
        );
        continue;
      }

      await incrementMentionAttempt(mention.id);
      await sendReminder(mention, mention.attempts + 1, a2aRetryConfig.maxAttempts);
      logVerbose(
        `a2a-retry: sent reminder for mention ${mention.id} (attempt ${mention.attempts + 1})`,
      );
    } catch (err) {
      logVerbose(`a2a-retry: error processing mention ${mention.id}: ${String(err)}`);
    }
  }
}

async function sendReminder(
  mention: TrackedMention,
  currentAttempt: number,
  maxAttempts: number,
): Promise<void> {
  const text = `[리마인더 ${currentAttempt}/${maxAttempts}] <@${mention.targetBotId}> 위 요청에 대해 확인 부탁해요.`;
  try {
    await sendMessageDiscord(`channel:${mention.threadId}`, text);
  } catch (err) {
    logVerbose(`a2a-retry: failed to send reminder for mention ${mention.id}: ${String(err)}`);
  }
}

async function sendEscalation(
  mention: TrackedMention,
  attempts: number,
  escalationMentionId?: string,
): Promise<void> {
  const escalationPart = escalationMentionId ? ` <@${escalationMentionId}> 확인 필요` : "";
  const text = `⚠️ 응답 없음 (${attempts}회 시도). 대상: <@${mention.targetBotId}>.${escalationPart}`;
  try {
    await sendMessageDiscord(`channel:${mention.threadId}`, text);
  } catch (err) {
    logVerbose(`a2a-retry: failed to send escalation for mention ${mention.id}: ${String(err)}`);
  }
}

// Re-export truncateText for internal use if needed
export { truncateText };
