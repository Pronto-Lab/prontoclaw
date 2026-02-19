/**
 * A2A Job Manager — Durable persistence layer for A2A flows.
 *
 * Provides file-based storage for A2A job records, enabling:
 * - Survival across gateway restarts
 * - Status tracking (PENDING → RUNNING → COMPLETED/FAILED/ABANDONED)
 * - Stale job detection and cleanup
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("a2a-job-manager");

// ─── Types ───

export type A2AJobStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "ABANDONED";

export interface A2AJobRecord {
  /** Job ID (same as runId) */
  jobId: string;
  /** Current status */
  status: A2AJobStatus;
  /** Requester session key */
  requesterSessionKey?: string;
  /** Target session key */
  targetSessionKey: string;
  /** Display key for target */
  displayKey: string;
  /** Message to send */
  message: string;
  /** Conversation ID */
  conversationId: string;
  /** Max ping-pong turns */
  maxPingPongTurns: number;
  /** Current turn (for resume) */
  currentTurn: number;
  /** Announce timeout (ms) */
  announceTimeoutMs: number;
  /** Task context */
  taskId?: string;
  workSessionId?: string;
  parentConversationId?: string;
  depth?: number;
  hop?: number;
  skipPingPong?: boolean;
  /** Timing */
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Resume tracking */
  resumeCount: number;
  /** Last error message */
  lastError?: string;
}

// ─── Constants ───

const JOBS_SUBDIR = "a2a-jobs";
const JOB_FILE_PREFIX = "job-";
const JOB_FILE_SUFFIX = ".json";
/** Completed/failed/abandoned jobs older than this are auto-deleted */
const FINISHED_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Jobs running longer than this are considered stale */
export const STALE_JOB_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

// ─── Singleton ───

let _instance: A2AJobManager | null = null;

export function initA2AJobManager(stateDir: string): A2AJobManager {
  _instance = new A2AJobManager(path.join(stateDir, JOBS_SUBDIR));
  return _instance;
}

export function getA2AJobManager(): A2AJobManager | null {
  return _instance;
}

/** @internal — testing only */
export function resetA2AJobManager(): void {
  _instance = null;
}

// ─── Manager Class ───

export class A2AJobManager {
  constructor(private readonly jobsDir: string) {}

  /** Ensure the jobs directory exists */
  async init(): Promise<void> {
    await fs.mkdir(this.jobsDir, { recursive: true });
  }

  /** Create a new job record in PENDING state */
  async createJob(params: Omit<A2AJobRecord, "status" | "createdAt" | "updatedAt" | "currentTurn" | "resumeCount">): Promise<A2AJobRecord> {
    const now = Date.now();
    const job: A2AJobRecord = {
      ...params,
      status: "PENDING",
      currentTurn: 0,
      createdAt: now,
      updatedAt: now,
      resumeCount: 0,
    };
    await this.persistJob(job);
    log.info("A2A job created", { jobId: job.jobId, target: job.targetSessionKey });
    return job;
  }

  /** Update job status */
  async updateStatus(
    jobId: string,
    status: A2AJobStatus,
    extra?: Partial<Pick<A2AJobRecord, "lastError" | "finishedAt" | "currentTurn" | "resumeCount">>,
  ): Promise<A2AJobRecord | null> {
    const job = await this.readJob(jobId);
    if (!job) {
      log.warn("Cannot update status: job not found", { jobId, status });
      return null;
    }
    job.status = status;
    job.updatedAt = Date.now();
    if (extra) {
      if (extra.lastError !== undefined) job.lastError = extra.lastError;
      if (extra.finishedAt !== undefined) job.finishedAt = extra.finishedAt;
      if (extra.currentTurn !== undefined) job.currentTurn = extra.currentTurn;
      if (extra.resumeCount !== undefined) job.resumeCount = extra.resumeCount;
    }
    await this.persistJob(job);
    log.debug("A2A job status updated", { jobId, status });
    return job;
  }

  /** Record turn progress */
  async recordTurnProgress(jobId: string, turn: number): Promise<void> {
    const job = await this.readJob(jobId);
    if (!job) return;
    job.currentTurn = turn;
    job.updatedAt = Date.now();
    await this.persistJob(job);
  }

  /** Mark job as completed */
  async completeJob(jobId: string): Promise<void> {
    await this.updateStatus(jobId, "COMPLETED", { finishedAt: Date.now() });
    log.info("A2A job completed", { jobId });
  }

  /** Mark job as failed */
  async failJob(jobId: string, error: string): Promise<void> {
    await this.updateStatus(jobId, "FAILED", { lastError: error, finishedAt: Date.now() });
    log.info("A2A job failed", { jobId, error });
  }

  /** Mark job as abandoned (stale) */
  async abandonJob(jobId: string): Promise<void> {
    await this.updateStatus(jobId, "ABANDONED", { finishedAt: Date.now() });
    log.info("A2A job abandoned (stale)", { jobId });
  }

  /** Read a single job */
  async readJob(jobId: string): Promise<A2AJobRecord | null> {
    const filePath = path.join(this.jobsDir, `${JOB_FILE_PREFIX}${jobId}${JOB_FILE_SUFFIX}`);
    return this.readJobFromFile(filePath);
  }

  /** Get all incomplete jobs (PENDING or RUNNING) */
  async getIncompleteJobs(): Promise<A2AJobRecord[]> {
    const files = await this.listJobFiles();
    const jobs: A2AJobRecord[] = [];
    for (const file of files) {
      const job = await this.readJobFromFile(path.join(this.jobsDir, file));
      if (job && (job.status === "PENDING" || job.status === "RUNNING")) {
        jobs.push(job);
      }
    }
    return jobs;
  }

  /** Get all jobs (for diagnostics) */
  async getAllJobs(): Promise<A2AJobRecord[]> {
    const files = await this.listJobFiles();
    const jobs: A2AJobRecord[] = [];
    for (const file of files) {
      const job = await this.readJobFromFile(path.join(this.jobsDir, file));
      if (job) jobs.push(job);
    }
    return jobs;
  }

  /** Delete a job file */
  async deleteJob(jobId: string): Promise<void> {
    const filePath = path.join(this.jobsDir, `${JOB_FILE_PREFIX}${jobId}${JOB_FILE_SUFFIX}`);
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore if already deleted
    }
  }

  /** Clean up old finished job files (> 7 days) */
  async cleanupFinishedJobs(): Promise<number> {
    const files = await this.listJobFiles();
    let cleaned = 0;
    const now = Date.now();
    for (const file of files) {
      const job = await this.readJobFromFile(path.join(this.jobsDir, file));
      if (!job) continue;
      const isFinished = job.status === "COMPLETED" || job.status === "FAILED" || job.status === "ABANDONED";
      if (isFinished && job.finishedAt && now - job.finishedAt > FINISHED_JOB_TTL_MS) {
        await this.deleteJob(job.jobId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.info("Cleaned up finished A2A jobs", { cleaned });
    }
    return cleaned;
  }

  /** Check if a job is stale (RUNNING for too long) */
  isStale(job: A2AJobRecord): boolean {
    if (job.status !== "RUNNING") return false;
    return Date.now() - job.updatedAt > STALE_JOB_THRESHOLD_MS;
  }

  // ─── Internal ───

  private async persistJob(job: A2AJobRecord): Promise<void> {
    const filePath = path.join(this.jobsDir, `${JOB_FILE_PREFIX}${job.jobId}${JOB_FILE_SUFFIX}`);
    const tmpPath = filePath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(job, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  }

  private async readJobFromFile(filePath: string): Promise<A2AJobRecord | null> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as A2AJobRecord;
    } catch {
      return null;
    }
  }

  private async listJobFiles(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.jobsDir);
      return files.filter((f) => f.startsWith(JOB_FILE_PREFIX) && f.endsWith(JOB_FILE_SUFFIX));
    } catch {
      return [];
    }
  }
}
