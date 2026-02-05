import fs from "node:fs";
import path from "node:path";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";
import { resolveStateDir } from "../../config/paths.js";
import { ensureAuthProfileStore, isProfileInCooldown, resolveAuthProfileOrder } from "../../agents/auth-profiles.js";
import { defaultRuntime } from "../../runtime.js";

const QUEUE_FILENAME = "quota-recovery-queue.json";
const DEFAULT_RETRY_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
const MAX_RETRY_ATTEMPTS = 12; // 4 hours total (20min * 12)

export type QuotaRecoveryTask = {
  id: string;
  createdAt: number;
  lastAttemptAt?: number;
  attemptCount: number;
  commandBody: string;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
  /** Serializable subset of GetReplyOptions */
  opts?: {
    runId?: string;
    isHeartbeat?: boolean;
    skillFilter?: string[];
  };
  /** Session metadata for restoration */
  sessionMeta?: {
    sessionKey?: string;
    storePath?: string;
  };
  /** Original error message for debugging */
  originalError: string;
};

type QuotaRecoveryQueueStore = {
  version: 1;
  tasks: QuotaRecoveryTask[];
};

/**
 * Callback type for handling recovered tasks.
 * Return the reply payload to send back to the user, or undefined to skip.
 */
export type QuotaRecoveryTaskHandler = (
  task: QuotaRecoveryTask
) => Promise<ReplyPayload | undefined>;

let queueInstance: QuotaRecoveryQueue | null = null;

export function getQuotaRecoveryQueue(): QuotaRecoveryQueue {
  if (!queueInstance) {
    queueInstance = new QuotaRecoveryQueue();
  }
  return queueInstance;
}

export class QuotaRecoveryQueue {
  private tasks: QuotaRecoveryTask[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private taskHandler: QuotaRecoveryTaskHandler | null = null;
  private retryIntervalMs: number;
  private queuePath: string;

  constructor(opts?: { retryIntervalMs?: number; stateDir?: string }) {
    this.retryIntervalMs = opts?.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    const stateDir = opts?.stateDir ?? resolveStateDir();
    this.queuePath = path.join(stateDir, QUEUE_FILENAME);
    this.loadFromDisk();
    this.startRetryTimer();
  }

  /**
   * Register the callback that will be invoked when a task is ready for retry.
   * This should be set during gateway initialization.
   */
  setTaskHandler(handler: QuotaRecoveryTaskHandler): void {
    this.taskHandler = handler;
    defaultRuntime.log("[QuotaRecovery] Task handler registered");
  }

  /**
   * Add a failed task to the recovery queue.
   */
  enqueue(params: {
    commandBody: string;
    followupRun: FollowupRun;
    sessionCtx: TemplateContext;
    opts?: GetReplyOptions;
    sessionKey?: string;
    storePath?: string;
    originalError: string;
  }): QuotaRecoveryTask {
    const task: QuotaRecoveryTask = {
      id: `qr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      attemptCount: 0,
      commandBody: params.commandBody,
      followupRun: params.followupRun,
      sessionCtx: params.sessionCtx,
      opts: params.opts ? {
        runId: params.opts.runId,
        isHeartbeat: params.opts.isHeartbeat,
        skillFilter: params.opts.skillFilter,
      } : undefined,
      sessionMeta: {
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      originalError: params.originalError,
    };

    this.tasks.push(task);
    this.saveToDisk();

    defaultRuntime.log(
      `[QuotaRecovery] Task ${task.id} queued for retry. Queue depth: ${this.tasks.length}`
    );

    return task;
  }

  /**
   * Remove a task from the queue (after successful completion or max retries).
   */
  dequeue(taskId: string): boolean {
    const idx = this.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;
    this.tasks.splice(idx, 1);
    this.saveToDisk();
    return true;
  }

  /**
   * Get current queue depth.
   */
  getQueueDepth(): number {
    return this.tasks.length;
  }

  /**
   * Get all pending tasks (for debugging/status).
   */
  getPendingTasks(): QuotaRecoveryTask[] {
    return [...this.tasks];
  }

  /**
   * Check if any provider has quota available.
   */
  isQuotaAvailable(agentDir?: string, cfg?: FollowupRun["run"]["config"]): boolean {
    try {
      const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
      if (!authStore) return true; // No auth store = assume available

      // Check common providers
      const providers = ["anthropic", "openai", "google"];
      for (const provider of providers) {
        const profileIds = resolveAuthProfileOrder({ cfg, store: authStore, provider });
        const hasAvailable = profileIds.some((id) => !isProfileInCooldown(authStore, id));
        if (hasAvailable) return true;
      }

      return false;
    } catch (err) {
      defaultRuntime.error(`[QuotaRecovery] Error checking quota: ${String(err)}`);
      return true; // Assume available on error
    }
  }

  /**
   * Process pending tasks if quota is available.
   */
  async processQueue(): Promise<void> {
    if (this.isProcessing) {
      defaultRuntime.log("[QuotaRecovery] Already processing, skipping...");
      return;
    }
    if (this.tasks.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      // Process tasks in order (FIFO)
      const tasksToProcess = [...this.tasks];

      for (const task of tasksToProcess) {
        // Check quota before each task
        const agentDir = task.followupRun.run.agentDir;
        const cfg = task.followupRun.run.config;

        if (!this.isQuotaAvailable(agentDir, cfg)) {
          defaultRuntime.log(
            `[QuotaRecovery] Quota still unavailable, deferring task ${task.id}`
          );
          continue;
        }

        // Check max retry attempts
        if (task.attemptCount >= MAX_RETRY_ATTEMPTS) {
          defaultRuntime.error(
            `[QuotaRecovery] Task ${task.id} exceeded max retries (${MAX_RETRY_ATTEMPTS}), removing from queue`
          );
          this.dequeue(task.id);
          continue;
        }

        defaultRuntime.log(
          `[QuotaRecovery] Attempting task ${task.id} (attempt ${task.attemptCount + 1}/${MAX_RETRY_ATTEMPTS})`
        );

        // Update attempt metadata
        task.attemptCount += 1;
        task.lastAttemptAt = Date.now();
        this.saveToDisk();

        try {
          if (this.taskHandler) {
            await this.taskHandler(task);
            defaultRuntime.log(`[QuotaRecovery] Task ${task.id} completed via handler`);
          } else {
            // No handler registered - just log quota recovery
            defaultRuntime.log(`[QuotaRecovery] Task ${task.id} - quota available, no handler registered`);
          }
          // Success - remove from queue
          this.dequeue(task.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const isRateLimit = /rate.?limit|quota|429|all models failed/i.test(message);

          if (isRateLimit) {
            defaultRuntime.log(
              `[QuotaRecovery] Task ${task.id} still rate limited, will retry later`
            );
            // Keep in queue for next retry cycle
          } else {
            // Non-rate-limit error - remove from queue to avoid infinite retries
            defaultRuntime.error(
              `[QuotaRecovery] Task ${task.id} failed with non-recoverable error: ${message}`
            );
            this.dequeue(task.id);
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Trigger an immediate queue check (useful after config reload).
   */
  async triggerCheck(): Promise<void> {
    await this.processQueue();
  }

  /**
   * Start the background retry timer.
   */
  private startRetryTimer(): void {
    if (this.retryTimer) return;

    this.retryTimer = setInterval(async () => {
      await this.processQueue();
    }, this.retryIntervalMs);

    // Prevent timer from keeping process alive
    this.retryTimer.unref?.();

    defaultRuntime.log(
      `[QuotaRecovery] Retry timer started (interval: ${this.retryIntervalMs / 1000 / 60}min)`
    );
  }

  /**
   * Stop the background retry timer.
   */
  stopRetryTimer(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Load queue from disk (for persistence across restarts).
   */
  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.queuePath)) {
        this.tasks = [];
        return;
      }

      const raw = fs.readFileSync(this.queuePath, "utf-8");
      const parsed: QuotaRecoveryQueueStore = JSON.parse(raw);

      if (parsed.version !== 1) {
        defaultRuntime.error(`[QuotaRecovery] Unknown queue version: ${parsed.version}`);
        this.tasks = [];
        return;
      }

      this.tasks = parsed.tasks ?? [];
      if (this.tasks.length > 0) {
        defaultRuntime.log(
          `[QuotaRecovery] Loaded ${this.tasks.length} tasks from disk`
        );
      }
    } catch (err) {
      defaultRuntime.error(`[QuotaRecovery] Failed to load queue: ${String(err)}`);
      this.tasks = [];
    }
  }

  /**
   * Save queue to disk.
   */
  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.queuePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const store: QuotaRecoveryQueueStore = {
        version: 1,
        tasks: this.tasks,
      };

      fs.writeFileSync(this.queuePath, JSON.stringify(store, null, 2));
    } catch (err) {
      defaultRuntime.error(`[QuotaRecovery] Failed to save queue: ${String(err)}`);
    }
  }

  /**
   * Clear all tasks (for testing/reset).
   */
  clear(): void {
    this.tasks = [];
    this.saveToDisk();
  }
}

/**
 * Detect if an error is a rate-limit exhaustion (all models failed due to rate limiting).
 */
export function isRateLimitExhaustion(error: unknown): boolean {
  if (!error) return false;

  const message = error instanceof Error ? error.message : String(error);

  // Match "All models failed" with rate_limit reason
  if (/all models failed/i.test(message) && /rate.?limit/i.test(message)) {
    return true;
  }

  // Match explicit quota/billing errors
  if (/quota|billing|429|too many requests/i.test(message)) {
    return true;
  }

  return false;
}

/**
 * Generate a user-friendly message for rate limit queuing.
 */
export function generateQuotaQueuedMessage(taskId: string, retryMinutes: number = 20): string {
  return `⏳ All AI models are currently at capacity. Your request has been queued and will automatically retry in ~${retryMinutes} minutes.

_Task ID: ${taskId}_`;
}
