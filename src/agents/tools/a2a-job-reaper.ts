/**
 * A2A Job Reaper — Handles stale job detection and post-restart recovery.
 *
 * On gateway startup:
 * 1. Scans for incomplete jobs (PENDING/RUNNING)
 * 2. Abandons jobs that have been RUNNING for too long (stale)
 * 3. Resets remaining RUNNING jobs to PENDING (for resume)
 * 4. Cleans up old finished job files
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { A2AJobManager, A2AJobRecord } from "./a2a-job-manager.js";

const log = createSubsystemLogger("a2a-job-reaper");

export interface ReaperResult {
  /** Jobs reset from RUNNING to PENDING (available for resume) */
  resetToPending: number;
  /** Jobs marked as ABANDONED (stale) */
  abandoned: number;
  /** Old finished job files deleted */
  cleanedUp: number;
  /** Total incomplete jobs found */
  totalIncomplete: number;
}

export class A2AJobReaper {
  constructor(private readonly manager: A2AJobManager) {}

  /**
   * Run on gateway startup. Processes all incomplete jobs:
   * - Stale RUNNING jobs → ABANDONED
   * - Non-stale RUNNING jobs → PENDING (for resume by caller)
   * - PENDING jobs → left as-is (already resumable)
   * - Old finished files → deleted
   */
  async runOnStartup(): Promise<ReaperResult> {
    const result: ReaperResult = {
      resetToPending: 0,
      abandoned: 0,
      cleanedUp: 0,
      totalIncomplete: 0,
    };

    const incompleteJobs = await this.manager.getIncompleteJobs();
    result.totalIncomplete = incompleteJobs.length;

    if (incompleteJobs.length === 0) {
      log.debug("No incomplete A2A jobs found on startup");
    } else {
      log.info("Found incomplete A2A jobs on startup", { count: incompleteJobs.length });
    }

    for (const job of incompleteJobs) {
      if (job.status === "RUNNING") {
        if (this.manager.isStale(job)) {
          await this.manager.abandonJob(job.jobId);
          result.abandoned++;
          log.info("Abandoned stale A2A job", {
            jobId: job.jobId,
            target: job.targetSessionKey,
            lastUpdated: new Date(job.updatedAt).toISOString(),
          });
        } else {
          // Reset to PENDING so it can be resumed
          await this.manager.updateStatus(job.jobId, "PENDING", {
            resumeCount: job.resumeCount + 1,
          });
          result.resetToPending++;
          log.info("Reset A2A job to PENDING for resume", {
            jobId: job.jobId,
            target: job.targetSessionKey,
            currentTurn: job.currentTurn,
            resumeCount: job.resumeCount + 1,
          });
        }
      }
      // PENDING jobs are already in the right state for resume
    }

    // Clean up old finished files
    result.cleanedUp = await this.manager.cleanupFinishedJobs();

    if (result.abandoned > 0 || result.resetToPending > 0 || result.cleanedUp > 0) {
      log.info("A2A job reaper completed", { ...result });
    }

    return result;
  }

  /**
   * Get all jobs that are ready to be resumed (PENDING status).
   * Caller is responsible for actually restarting the A2A flows.
   */
  async getResumableJobs(): Promise<A2AJobRecord[]> {
    const incomplete = await this.manager.getIncompleteJobs();
    return incomplete.filter((j) => j.status === "PENDING");
  }
}
