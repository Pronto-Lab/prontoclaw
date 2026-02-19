/**
 * A2A structured payload parser & validator.
 *
 * Parses optional `payloadJson` strings into typed A2APayload objects.
 * Designed for graceful degradation: parsing/validation failures return null
 * rather than throwing, so the free-text fallback always works.
 *
 * @see 08-structured-handoff.md
 */

import type {
  A2APayload,
  A2APayloadType,
  AnswerPayload,
  PayloadValidationResult,
  QuestionPayload,
  StatusReportPayload,
  TaskDelegationPayload,
} from "./a2a-payload-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_PAYLOAD_TYPES = new Set<string>([
  "task_delegation",
  "status_report",
  "question",
  "answer",
]);

const VALID_PRIORITIES = new Set(["critical", "high", "medium", "low"]);
const VALID_STATUSES = new Set(["in_progress", "completed", "blocked", "failed"]);
const VALID_URGENCIES = new Set(["urgent", "normal", "low"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string into a validated A2APayload.
 * Returns null on any parsing or validation failure (never throws).
 */
export function parseA2APayload(payloadJson: string): A2APayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string" || !VALID_PAYLOAD_TYPES.has(type)) {
    return null;
  }

  const result = validateA2APayload(obj as unknown as A2APayload);
  if (!result.valid) {
    return null;
  }

  return obj as unknown as A2APayload;
}

/**
 * Validate structural correctness of a payload object.
 * Checks required fields and value constraints per payload type.
 */
export function validateA2APayload(payload: A2APayload): PayloadValidationResult {
  const errors: string[] = [];

  switch (payload.type) {
    case "task_delegation":
      validateTaskDelegation(payload, errors);
      break;
    case "status_report":
      validateStatusReport(payload, errors);
      break;
    case "question":
      validateQuestion(payload, errors);
      break;
    case "answer":
      validateAnswer(payload, errors);
      break;
    default:
      errors.push(`Unknown payload type: ${(payload as { type: string }).type}`);
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Build a concise human-readable summary of a payload.
 * Used to enrich agent-to-agent message context.
 */
export function buildPayloadSummary(payload: A2APayload): string {
  switch (payload.type) {
    case "task_delegation":
      return [
        `Task ID: ${payload.taskId}`,
        `Title: ${payload.taskTitle}`,
        `Description: ${payload.taskDescription}`,
        payload.priority ? `Priority: ${payload.priority}` : undefined,
        payload.deadline ? `Deadline: ${payload.deadline}` : undefined,
        payload.acceptanceCriteria?.length
          ? `Acceptance Criteria:\n${payload.acceptanceCriteria.map((c) => `  - ${c}`).join("\n")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n");

    case "status_report":
      return [
        `Task ID: ${payload.taskId}`,
        `Status: ${payload.status}`,
        payload.progressPercent !== undefined
          ? `Progress: ${payload.progressPercent}%`
          : undefined,
        payload.completedWork ? `Completed: ${payload.completedWork}` : undefined,
        payload.remainingWork ? `Remaining: ${payload.remainingWork}` : undefined,
        payload.blockers?.length
          ? `Blockers: ${payload.blockers.join(", ")}`
          : undefined,
        payload.artifacts?.length
          ? `Artifacts: ${payload.artifacts.join(", ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n");

    case "question":
      return [
        `Question ID: ${payload.questionId}`,
        `Question: ${payload.question}`,
        payload.urgency ? `Urgency: ${payload.urgency}` : undefined,
        payload.context ? `Context: ${payload.context}` : undefined,
        payload.options?.length
          ? `Options:\n${payload.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n");

    case "answer":
      return [
        `Question ID: ${payload.questionId}`,
        `Answer: ${payload.answer}`,
        payload.confidence !== undefined
          ? `Confidence: ${Math.round(payload.confidence * 100)}%`
          : undefined,
        payload.references?.length
          ? `References: ${payload.references.join(", ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n");
  }
}

/**
 * Map a payload type to the equivalent A2AMessageIntent
 * used by the intent classifier. When a structured payload is present
 * the classifier can skip LLM-based inference.
 */
export function mapPayloadTypeToMessageIntent(
  payloadType: A2APayloadType,
): "notification" | "question" | "collaboration" | "result_report" {
  switch (payloadType) {
    case "task_delegation":
      return "collaboration";
    case "status_report":
      return "result_report";
    case "question":
      return "question";
    case "answer":
      return "notification";
  }
}

// ---------------------------------------------------------------------------
// Internal validation helpers
// ---------------------------------------------------------------------------

function validateTaskDelegation(p: TaskDelegationPayload, errors: string[]): void {
  if (!p.taskId || typeof p.taskId !== "string") {
    errors.push("taskId is required and must be a string");
  }
  if (!p.taskTitle || typeof p.taskTitle !== "string") {
    errors.push("taskTitle is required and must be a string");
  }
  if (!p.taskDescription || typeof p.taskDescription !== "string") {
    errors.push("taskDescription is required and must be a string");
  }
  if (p.priority !== undefined && !VALID_PRIORITIES.has(p.priority)) {
    errors.push(`priority must be one of: ${[...VALID_PRIORITIES].join(", ")}`);
  }
  if (p.deadline !== undefined && typeof p.deadline !== "string") {
    errors.push("deadline must be a string (ISO 8601)");
  }
  if (p.context !== undefined && typeof p.context !== "string") {
    errors.push("context must be a string");
  }
  if (p.acceptanceCriteria !== undefined) {
    if (!Array.isArray(p.acceptanceCriteria)) {
      errors.push("acceptanceCriteria must be an array of strings");
    } else if (p.acceptanceCriteria.some((c) => typeof c !== "string")) {
      errors.push("acceptanceCriteria items must be strings");
    }
  }
}

function validateStatusReport(p: StatusReportPayload, errors: string[]): void {
  if (!p.taskId || typeof p.taskId !== "string") {
    errors.push("taskId is required and must be a string");
  }
  if (!p.status || typeof p.status !== "string") {
    errors.push("status is required and must be a string");
  } else if (!VALID_STATUSES.has(p.status)) {
    errors.push(`status must be one of: ${[...VALID_STATUSES].join(", ")}`);
  }
  if (p.progressPercent !== undefined) {
    if (typeof p.progressPercent !== "number" || p.progressPercent < 0 || p.progressPercent > 100) {
      errors.push("progressPercent must be a number between 0 and 100");
    }
  }
  if (p.completedWork !== undefined && typeof p.completedWork !== "string") {
    errors.push("completedWork must be a string");
  }
  if (p.remainingWork !== undefined && typeof p.remainingWork !== "string") {
    errors.push("remainingWork must be a string");
  }
  if (p.blockers !== undefined) {
    if (!Array.isArray(p.blockers)) {
      errors.push("blockers must be an array of strings");
    } else if (p.blockers.some((b) => typeof b !== "string")) {
      errors.push("blockers items must be strings");
    }
  }
  if (p.artifacts !== undefined) {
    if (!Array.isArray(p.artifacts)) {
      errors.push("artifacts must be an array of strings");
    } else if (p.artifacts.some((a) => typeof a !== "string")) {
      errors.push("artifacts items must be strings");
    }
  }
}

function validateQuestion(p: QuestionPayload, errors: string[]): void {
  if (!p.questionId || typeof p.questionId !== "string") {
    errors.push("questionId is required and must be a string");
  }
  if (!p.question || typeof p.question !== "string") {
    errors.push("question is required and must be a string");
  }
  if (p.urgency !== undefined && !VALID_URGENCIES.has(p.urgency)) {
    errors.push(`urgency must be one of: ${[...VALID_URGENCIES].join(", ")}`);
  }
  if (p.context !== undefined && typeof p.context !== "string") {
    errors.push("context must be a string");
  }
  if (p.options !== undefined) {
    if (!Array.isArray(p.options)) {
      errors.push("options must be an array of strings");
    } else if (p.options.some((o) => typeof o !== "string")) {
      errors.push("options items must be strings");
    }
  }
}

function validateAnswer(p: AnswerPayload, errors: string[]): void {
  if (!p.questionId || typeof p.questionId !== "string") {
    errors.push("questionId is required and must be a string");
  }
  if (!p.answer || typeof p.answer !== "string") {
    errors.push("answer is required and must be a string");
  }
  if (p.confidence !== undefined) {
    if (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 1) {
      errors.push("confidence must be a number between 0.0 and 1.0");
    }
  }
  if (p.references !== undefined) {
    if (!Array.isArray(p.references)) {
      errors.push("references must be an array of strings");
    } else if (p.references.some((r) => typeof r !== "string")) {
      errors.push("references items must be strings");
    }
  }
}
