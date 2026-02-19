/**
 * Task-Subagent delegation types.
 *
 * These types extend the Task file to track subagent delegations,
 * their lifecycle states, result snapshots, and verification status.
 *
 * @see 11-subagent-task-lifecycle.md for design rationale.
 */

// ---------------------------------------------------------------------------
// Delegation status
// ---------------------------------------------------------------------------

export type DelegationStatus =
  | "spawned"     // Subagent created
  | "running"     // Subagent executing
  | "completed"   // Subagent finished (unverified)
  | "verified"    // Parent accepted result
  | "rejected"    // Parent rejected result
  | "failed"      // Subagent errored / timed out
  | "retrying"    // Awaiting retry spawn
  | "abandoned";  // Max retries exceeded or manual give-up

/** Terminal states — no further transitions allowed. */
export const TERMINAL_DELEGATION_STATES = new Set<DelegationStatus>([
  "verified",
  "abandoned",
]);

/** Active (non-terminal) states. */
export const ACTIVE_DELEGATION_STATES = new Set<DelegationStatus>([
  "spawned",
  "running",
  "retrying",
]);

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** A single delegation record linking a Task to a subagent run. */
export interface TaskDelegation {
  /** Unique delegation ID (delegation_{uuid}). */
  delegationId: string;
  /** Linked subagent runId. */
  runId: string;
  /** Target agent ID. */
  targetAgentId: string;
  /** Target session key. */
  targetSessionKey: string;
  /** Delegated task description. */
  task: string;
  /** Display label. */
  label?: string;
  /** Current lifecycle status. */
  status: DelegationStatus;
  /** Number of retries performed. */
  retryCount: number;
  /** Maximum allowed retries (default: 3). */
  maxRetries: number;
  /** Error messages from previous attempts. */
  previousErrors: string[];
  /** Captured result snapshot (on completion). */
  resultSnapshot?: ResultSnapshot;
  /** Verification note (on accept/reject). */
  verificationNote?: string;
  /** Timestamps. */
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** Captured result from a completed subagent. */
export interface ResultSnapshot {
  /** Result content (truncated to MAX_SNAPSHOT_BYTES). */
  content: string;
  /** Outcome status from announce flow. */
  outcomeStatus: string;
  /** When the snapshot was captured. */
  capturedAt: number;
}

/** Delegation lifecycle event — appended to Task file. */
export interface DelegationEvent {
  type: DelegationEventType;
  delegationId: string;
  runId: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export type DelegationEventType =
  | "delegation_spawned"
  | "delegation_running"
  | "delegation_completed"
  | "delegation_failed"
  | "delegation_verified"
  | "delegation_rejected"
  | "delegation_retrying"
  | "delegation_abandoned";

/** Summary of all delegations under a single Task. */
export interface DelegationSummary {
  total: number;
  completed: number;
  verified: number;
  failed: number;
  running: number;
  /** True when every delegation has reached a terminal or settled state. */
  allSettled: boolean;
}

// ---------------------------------------------------------------------------
// Valid state transitions
// ---------------------------------------------------------------------------

export const VALID_DELEGATION_TRANSITIONS: Record<DelegationStatus, readonly DelegationStatus[]> = {
  spawned:   ["running", "failed", "abandoned"],
  running:   ["completed", "failed"],
  completed: ["verified", "rejected"],
  verified:  [],          // terminal
  rejected:  ["retrying", "abandoned"],
  failed:    ["retrying", "abandoned"],
  retrying:  ["spawned"],
  abandoned: [],          // terminal
} as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes for a result snapshot content. */
export const MAX_SNAPSHOT_BYTES = 10_000;

/** Default maximum retries per delegation. */
export const DEFAULT_MAX_RETRIES = 3;

/** Hard ceiling for maxRetries to prevent infinite loops. */
export const ABSOLUTE_MAX_RETRIES = 10;
