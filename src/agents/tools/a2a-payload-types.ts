/**
 * Structured A2A handoff payload types.
 *
 * These types define a machine-readable contract for agent-to-agent communication.
 * The free-text `message` field in sessions_send continues to serve as the
 * human-readable description; the structured payload provides unambiguous intent,
 * identifiers for idempotency/deduplication, and typed metadata.
 *
 * @see 08-structured-handoff.md for design rationale.
 */

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export type A2APayloadType =
  | "task_delegation"
  | "status_report"
  | "question"
  | "answer";

/** Agent A delegates a task to Agent B. */
export interface TaskDelegationPayload {
  type: "task_delegation";
  /** Unique task identifier — used for idempotency and status tracking. */
  taskId: string;
  /** One-line task title. */
  taskTitle: string;
  /** Full task description. */
  taskDescription: string;
  /** Optional execution context. */
  context?: string;
  /** Optional ISO 8601 deadline. */
  deadline?: string;
  /** Priority level. */
  priority?: "critical" | "high" | "medium" | "low";
  /** Acceptance criteria list. */
  acceptanceCriteria?: string[];
}

/** Agent B reports progress or completion to Agent A. */
export interface StatusReportPayload {
  type: "status_report";
  /** The task ID being reported on. */
  taskId: string;
  /** Current status. */
  status: "in_progress" | "completed" | "blocked" | "failed";
  /** Summary of work done. */
  completedWork?: string;
  /** Remaining work description. */
  remainingWork?: string;
  /** Blocker list. */
  blockers?: string[];
  /** Completion percentage 0–100. */
  progressPercent?: number;
  /** Result artifacts (paths, URLs). */
  artifacts?: string[];
}

/** Agent asks another agent a question. */
export interface QuestionPayload {
  type: "question";
  /** Unique question identifier — for answer matching. */
  questionId: string;
  /** The question text. */
  question: string;
  /** Context for the question. */
  context?: string;
  /** Urgency level. */
  urgency?: "urgent" | "normal" | "low";
  /** Multiple-choice options (optional). */
  options?: string[];
}

/** Agent answers a previously asked question. */
export interface AnswerPayload {
  type: "answer";
  /** The question ID being answered. */
  questionId: string;
  /** Answer text. */
  answer: string;
  /** Confidence 0.0–1.0 (optional). */
  confidence?: number;
  /** Supporting references (optional). */
  references?: string[];
}

/** Discriminated union of all payload types. */
export type A2APayload =
  | TaskDelegationPayload
  | StatusReportPayload
  | QuestionPayload
  | AnswerPayload;

/** Validation result returned by validateA2APayload. */
export interface PayloadValidationResult {
  valid: boolean;
  errors?: string[];
}
