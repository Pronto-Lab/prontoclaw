/**
 * Task-Delegation lifecycle manager.
 *
 * Pure functions — no I/O. Callers are responsible for reading/writing
 * the Task file. This module handles state transition validation,
 * event creation, and summary computation.
 *
 * @see 11-subagent-task-lifecycle.md
 */

import crypto from "node:crypto";
import {
  ABSOLUTE_MAX_RETRIES,
  DEFAULT_MAX_RETRIES,
  MAX_SNAPSHOT_BYTES,
  TERMINAL_DELEGATION_STATES,
  VALID_DELEGATION_TRANSITIONS,
  type DelegationEvent,
  type DelegationEventType,
  type DelegationStatus,
  type DelegationSummary,
  type ResultSnapshot,
  type TaskDelegation,
} from "./task-delegation-types.js";

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface DelegationCreateParams {
  taskId: string;
  runId: string;
  targetAgentId: string;
  targetSessionKey: string;
  task: string;
  label?: string;
  maxRetries?: number;
}

export interface DelegationCreateResult {
  delegation: TaskDelegation;
  event: DelegationEvent;
}

/**
 * Create a new delegation record.
 * Called when sessions_spawn is invoked with a taskId.
 */
export function createDelegation(params: DelegationCreateParams): DelegationCreateResult {
  const now = Date.now();
  const delegationId = `delegation_${crypto.randomUUID()}`;
  const maxRetries = Math.min(
    Math.max(0, params.maxRetries ?? DEFAULT_MAX_RETRIES),
    ABSOLUTE_MAX_RETRIES,
  );

  const delegation: TaskDelegation = {
    delegationId,
    runId: params.runId,
    targetAgentId: params.targetAgentId,
    targetSessionKey: params.targetSessionKey,
    task: params.task,
    label: params.label,
    status: "spawned",
    retryCount: 0,
    maxRetries,
    previousErrors: [],
    createdAt: now,
    updatedAt: now,
  };

  const event: DelegationEvent = {
    type: "delegation_spawned",
    delegationId,
    runId: params.runId,
    timestamp: now,
    data: {
      targetAgentId: params.targetAgentId,
      task: params.task,
    },
  };

  return { delegation, event };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface DelegationUpdateParams {
  status: DelegationStatus;
  resultSnapshot?: { content: string; outcomeStatus: string };
  verificationNote?: string;
  error?: string;
}

export type DelegationUpdateResult =
  | { ok: true; delegation: TaskDelegation; event: DelegationEvent }
  | { ok: false; error: string };

/**
 * Update a delegation's status.
 * Validates the state transition and produces the updated delegation + event.
 */
export function updateDelegation(
  current: TaskDelegation,
  update: DelegationUpdateParams,
): DelegationUpdateResult {
  const validationError = validateTransition(current.status, update.status);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const now = Date.now();
  const updated: TaskDelegation = {
    ...current,
    status: update.status,
    updatedAt: now,
  };

  // Status-specific mutations
  if (update.status === "completed" || update.status === "failed") {
    updated.completedAt = now;
  }

  if (update.resultSnapshot) {
    const content = update.resultSnapshot.content.length > MAX_SNAPSHOT_BYTES
      ? update.resultSnapshot.content.slice(0, MAX_SNAPSHOT_BYTES)
      : update.resultSnapshot.content;
    updated.resultSnapshot = {
      content,
      outcomeStatus: update.resultSnapshot.outcomeStatus,
      capturedAt: now,
    };
  }

  if (update.verificationNote !== undefined) {
    updated.verificationNote = update.verificationNote;
  }

  if (update.error) {
    updated.previousErrors = [...current.previousErrors, update.error];
  }

  if (update.status === "retrying") {
    updated.retryCount = current.retryCount + 1;
    updated.completedAt = undefined;
  }

  const eventType: DelegationEventType = `delegation_${update.status}` as DelegationEventType;
  const event: DelegationEvent = {
    type: eventType,
    delegationId: current.delegationId,
    runId: current.runId,
    timestamp: now,
    data: {
      previousStatus: current.status,
      ...(update.resultSnapshot ? { hasResult: true } : {}),
      ...(update.error ? { error: update.error } : {}),
      ...(update.verificationNote ? { note: update.verificationNote } : {}),
    },
  };

  return { ok: true, delegation: updated, event };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Compute an aggregate summary of delegations.
 */
export function computeDelegationSummary(delegations: TaskDelegation[]): DelegationSummary {
  let completed = 0;
  let verified = 0;
  let failed = 0;
  let running = 0;

  for (const d of delegations) {
    switch (d.status) {
      case "completed":
        completed++;
        break;
      case "verified":
        verified++;
        break;
      case "failed":
      case "abandoned":
        failed++;
        break;
      case "spawned":
      case "running":
      case "retrying":
        running++;
        break;
      case "rejected":
        // rejected is neither running nor terminal until retried or abandoned
        break;
    }
  }

  const allSettled = delegations.length > 0 && delegations.every((d) =>
    TERMINAL_DELEGATION_STATES.has(d.status) || d.status === "rejected",
  );

  return {
    total: delegations.length,
    completed,
    verified,
    failed,
    running,
    allSettled,
  };
}

// ---------------------------------------------------------------------------
// Retry check
// ---------------------------------------------------------------------------

/**
 * Check whether a delegation can be retried.
 */
export function canRetry(delegation: TaskDelegation): boolean {
  if (delegation.status !== "failed" && delegation.status !== "rejected") {
    return false;
  }
  return delegation.retryCount < delegation.maxRetries;
}

// ---------------------------------------------------------------------------
// Find helpers
// ---------------------------------------------------------------------------

/**
 * Find a delegation by runId within a delegation list.
 */
export function findDelegationByRunId(
  delegations: TaskDelegation[],
  runId: string,
): TaskDelegation | undefined {
  return delegations.find((d) => d.runId === runId);
}

/**
 * Find the latest completed (unverified) delegation.
 */
export function findLatestCompletedDelegation(
  delegations: TaskDelegation[],
): TaskDelegation | undefined {
  for (let i = delegations.length - 1; i >= 0; i--) {
    if (delegations[i].status === "completed") {
      return delegations[i];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function validateTransition(from: DelegationStatus, to: DelegationStatus): string | undefined {
  const allowed = VALID_DELEGATION_TRANSITIONS[from];
  if (allowed.includes(to)) {
    return undefined;
  }
  const allowedStr = allowed.length > 0 ? allowed.join(", ") : "none (terminal state)";
  return `Invalid delegation transition: ${from} → ${to}. Allowed from ${from}: ${allowedStr}`;
}
