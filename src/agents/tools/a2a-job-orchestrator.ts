/**
 * A2A Job Orchestrator — Bridges A2AJobManager with runSessionsSendA2AFlow().
 *
 * This module exists to avoid circular dependencies between:
 * - a2a-job-manager.ts (persistence layer)
 * - sessions-send-tool.a2a.ts (flow execution)
 *
 * It provides two entry points:
 * 1. createAndStartFlow() — replace fire-and-forget `void runSessionsSendA2AFlow()`
 * 2. resumeFlows() — called by reaper on gateway restart to resume PENDING jobs
 */

import { emit } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getA2AJobManager } from "./a2a-job-manager.js";
import type { A2AJobRecord } from "./a2a-job-manager.js";
import type { A2APayloadType } from "./a2a-payload-types.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const log = createSubsystemLogger("a2a-job-orchestrator");

/** Parameters matching the subset of runSessionsSendA2AFlow params we persist */
export interface CreateA2AJobFlowParams {
  jobId: string;
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: import("../../utils/message-channel.js").GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
  conversationId?: string;
  taskId?: string;
  workSessionId?: string;
  parentConversationId?: string;
  depth?: number;
  hop?: number;
  skipPingPong?: boolean;
  /** Structured payload type from sender. */
  payloadType?: A2APayloadType;
  /** Raw structured payload JSON from sender. */
  payloadJson?: string;
  /** Topic channel ID for dashboard routing. */
  topicId?: string;
}

/**
 * Create a durable A2A job and start the flow immediately.
 * Replaces: `void runSessionsSendA2AFlow({...})`
 *
 * The job is persisted to disk BEFORE the flow starts, so it survives gateway restarts.
 * Returns the jobId for tracking.
 */
export async function createAndStartFlow(params: CreateA2AJobFlowParams): Promise<string> {
  const manager = getA2AJobManager();
  if (!manager) {
    // Fallback: no job manager initialized — run flow directly (legacy behavior)
    log.warn("A2AJobManager not initialized, running flow without durability", {
      jobId: params.jobId,
    });
    void runFlowDirect(params);
    return params.jobId;
  }

  // Create job record (persisted as PENDING)
  const job = await manager.createJob({
    jobId: params.jobId,
    targetSessionKey: params.targetSessionKey,
    displayKey: params.displayKey,
    message: params.message,
    conversationId: params.conversationId ?? params.jobId,
    maxPingPongTurns: params.maxPingPongTurns,
    announceTimeoutMs: params.announceTimeoutMs,
    requesterSessionKey: params.requesterSessionKey,
    taskId: params.taskId,
    workSessionId: params.workSessionId,
    parentConversationId: params.parentConversationId,
    depth: params.depth,
    hop: params.hop,
    skipPingPong: params.skipPingPong,
  });

  // Start the flow (non-blocking)
  void startJobFlow(
    job,
    params.requesterChannel,
    params.roundOneReply,
    params.waitRunId,
    params.payloadType,
    params.payloadJson,
    params.topicId,
  );

  return job.jobId;
}

/**
 * Resume all PENDING jobs after gateway restart.
 * Called by A2AJobReaper.getResumableJobs() result.
 */
export async function resumeFlows(jobs: A2AJobRecord[]): Promise<number> {
  let resumed = 0;
  for (const job of jobs) {
    log.info("Resuming A2A job flow", {
      jobId: job.jobId,
      currentTurn: job.currentTurn,
      resumeCount: job.resumeCount,
    });
    // For resumed jobs, we don't have roundOneReply or waitRunId — the flow
    // will skip the initial wait phase and go directly into ping-pong from startTurn.
    // requesterChannel is also unavailable after restart.
    void startJobFlow(job, undefined, undefined, undefined);
    resumed++;
  }
  return resumed;
}

// ─── Internal ───

async function startJobFlow(
  job: A2AJobRecord,
  requesterChannel?: import("../../utils/message-channel.js").GatewayMessageChannel,
  roundOneReply?: string,
  waitRunId?: string,
  payloadType?: A2APayloadType,
  payloadJson?: string,
  topicId?: string,
): Promise<void> {
  const manager = getA2AJobManager();
  if (!manager) {
    return;
  }

  const abort = new AbortController();

  // Transition to RUNNING
  await manager.updateStatus(job.jobId, "RUNNING");

  try {
    await runSessionsSendA2AFlow({
      targetSessionKey: job.targetSessionKey,
      displayKey: job.displayKey,
      message: job.message,
      announceTimeoutMs: job.announceTimeoutMs,
      maxPingPongTurns: job.maxPingPongTurns,
      requesterSessionKey: job.requesterSessionKey,
      requesterChannel,
      roundOneReply,
      waitRunId,
      conversationId: job.conversationId,
      taskId: job.taskId,
      workSessionId: job.workSessionId,
      parentConversationId: job.parentConversationId,
      depth: job.depth,
      hop: job.hop,
      skipPingPong: job.skipPingPong,
      startTurn: job.currentTurn,
      payloadType,
      payloadJson,
      topicId,
      signal: abort.signal,
      onTurnComplete: async (turn: number) => {
        await manager.recordTurnProgress(job.jobId, turn);
      },
    });

    // Flow completed successfully
    await manager.completeJob(job.jobId);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await manager.failJob(job.jobId, errorMsg);
    log.warn("A2A job flow failed", { jobId: job.jobId, error: errorMsg });

    const failFromAgent = resolveAgentIdFromSessionKey(job.requesterSessionKey);
    const failToAgent = resolveAgentIdFromSessionKey(job.targetSessionKey);
    emit({
      type: EVENT_TYPES.A2A_COMPLETE,
      agentId: failFromAgent,
      ts: Date.now(),
      data: {
        fromAgent: failFromAgent,
        toAgent: failToAgent,
        announced: false,
        targetSessionKey: job.targetSessionKey,
        conversationId: job.conversationId,
        outcome: "failed",
        error: errorMsg,
        taskId: job.taskId,
        workSessionId: job.workSessionId,
      },
    });
  }
}

/** Direct flow execution without job tracking (fallback when manager not initialized) */
function runFlowDirect(params: CreateA2AJobFlowParams): Promise<void> {
  return runSessionsSendA2AFlow({
    targetSessionKey: params.targetSessionKey,
    displayKey: params.displayKey,
    message: params.message,
    announceTimeoutMs: params.announceTimeoutMs,
    maxPingPongTurns: params.maxPingPongTurns,
    requesterSessionKey: params.requesterSessionKey,
    requesterChannel: params.requesterChannel,
    roundOneReply: params.roundOneReply,
    waitRunId: params.waitRunId,
    conversationId: params.conversationId,
    taskId: params.taskId,
    workSessionId: params.workSessionId,
    parentConversationId: params.parentConversationId,
    depth: params.depth,
    hop: params.hop,
    skipPingPong: params.skipPingPong,
    payloadType: params.payloadType,
    payloadJson: params.payloadJson,
    topicId: params.topicId,
  });
}
