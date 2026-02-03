import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { sendMessageDiscord } from "../send.outbound.js";
import {
  cleanupOldEntries,
  getTimedOutDms,
  incrementRetryAttempt,
  markDmFailed,
  type TrackedDm,
} from "./tracker.js";
import { resolveDmRetryConfig, truncateText } from "./utils.js";

let retryInterval: ReturnType<typeof setInterval> | null = null;
let configRef: OpenClawConfig | null = null;

const CHECK_INTERVAL_MS = 60_000;
const CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function startDmRetryScheduler(cfg: OpenClawConfig): void {
  const dmRetryConfig = resolveDmRetryConfig(cfg);
  if (!dmRetryConfig.enabled) {
    logVerbose("dm-retry: scheduler disabled");
    return;
  }

  if (retryInterval) {
    clearInterval(retryInterval);
  }

  configRef = cfg;
  logVerbose("dm-retry: scheduler started");

  retryInterval = setInterval(() => {
    void processPendingRetries().catch((err) => {
      logVerbose(`dm-retry: scheduler error: ${String(err)}`);
    });
  }, CHECK_INTERVAL_MS);
}

export function stopDmRetryScheduler(): void {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
    configRef = null;
    logVerbose("dm-retry: scheduler stopped");
  }
}

async function processPendingRetries(): Promise<void> {
  if (!configRef) {
    return;
  }

  const dmRetryConfig = resolveDmRetryConfig(configRef);
  if (!dmRetryConfig.enabled) {
    return;
  }

  await cleanupOldEntries(CLEANUP_MAX_AGE_MS);

  const timedOut = getTimedOutDms(dmRetryConfig.timeoutMs);
  if (timedOut.length === 0) {
    return;
  }

  logVerbose(`dm-retry: processing ${timedOut.length} timed-out DMs`);

  for (const dm of timedOut) {
    try {
      if (dm.attempts >= dmRetryConfig.maxAttempts) {
        await markDmFailed(dm.id);
        if (dmRetryConfig.notifyOnFailure) {
          await notifySenderOfFailure(dm);
        }
        logVerbose(`dm-retry: DM ${dm.id} marked failed after ${dm.attempts} attempts`);
        continue;
      }

      await incrementRetryAttempt(dm.id);
      await resendDm(dm);
      logVerbose(`dm-retry: resent DM ${dm.id} (attempt ${dm.attempts + 1})`);
    } catch (err) {
      logVerbose(`dm-retry: error processing DM ${dm.id}: ${String(err)}`);
    }
  }
}

async function resendDm(dm: TrackedDm): Promise<void> {
  const retryNote = `[Retry ${dm.attempts + 1}] `;
  await sendMessageDiscord(`channel:${dm.channelId}`, retryNote + dm.originalText);
}

async function notifySenderOfFailure(dm: TrackedDm): Promise<void> {
  const preview = truncateText(dm.originalText, 100);
  const notification = `⚠️ DM 전송 실패 (${dm.attempts}회 시도). 대상: ${dm.targetUserId}. 메시지: "${preview}"`;

  logVerbose(`dm-retry: notifying sender ${dm.senderAgentId}: ${notification}`);

  try {
    await sendMessageDiscord(`channel:${dm.channelId}`, notification);
  } catch (err) {
    logVerbose(`dm-retry: failed to send failure notification: ${String(err)}`);
  }
}

export function updateSchedulerConfig(cfg: OpenClawConfig): void {
  const wasEnabled = configRef ? resolveDmRetryConfig(configRef).enabled : false;
  const isEnabled = resolveDmRetryConfig(cfg).enabled;

  configRef = cfg;

  if (!wasEnabled && isEnabled) {
    startDmRetryScheduler(cfg);
  } else if (wasEnabled && !isEnabled) {
    stopDmRetryScheduler();
  }
}
