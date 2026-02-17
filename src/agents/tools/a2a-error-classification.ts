/**
 * A2A error classification and retry utilities.
 *
 * Classifies errors from agent.wait responses and Gateway connection failures
 * into retriable/permanent categories, and provides exponential backoff.
 */

export enum A2AErrorCategory {
  /** Retriable — network hiccups, rate limits, server overload, transient timeouts */
  TRANSIENT = "transient",
  /** Not retriable — context exceeded, invalid session, auth failures */
  PERMANENT = "permanent",
  /** Retriable with caution — unclassifiable errors, limited attempts */
  UNKNOWN = "unknown",
}

export interface A2AErrorInfo {
  category: A2AErrorCategory;
  code: string;
  reason: string;
  retriable: boolean;
}

/**
 * Classify an A2A error from either:
 * - An `agent.wait` response object `{ status, error }`
 * - A caught `Error` from `callGateway` connection failures
 */
export function classifyA2AError(input: { status?: string; error?: string } | Error): A2AErrorInfo {
  // Caught Error from callGateway (connection level)
  if (input instanceof Error) {
    const msg = input.message.toLowerCase();
    if (
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("socket hang up") ||
      msg.includes("econnrefused") ||
      msg.includes("dns") ||
      msg.includes("fetch failed")
    ) {
      return {
        category: A2AErrorCategory.TRANSIENT,
        code: "gateway_connection",
        reason: input.message,
        retriable: true,
      };
    }
    if (
      msg.includes("unauthorized") ||
      msg.includes("forbidden") ||
      msg.includes("401") ||
      msg.includes("403")
    ) {
      return {
        category: A2AErrorCategory.PERMANENT,
        code: "auth_failure",
        reason: input.message,
        retriable: false,
      };
    }
    return {
      category: A2AErrorCategory.UNKNOWN,
      code: "gateway_unknown",
      reason: input.message,
      retriable: true,
    };
  }

  // agent.wait response object
  const status = input.status;
  const errMsg = (input.error ?? "").toLowerCase();

  if (status === "ok") {
    // Not an error — shouldn't be classified, but handle gracefully
    return {
      category: A2AErrorCategory.TRANSIENT,
      code: "ok",
      reason: "not an error",
      retriable: false,
    };
  }

  if (status === "not_found") {
    return {
      category: A2AErrorCategory.PERMANENT,
      code: "run_not_found",
      reason: "run ID not found on gateway",
      retriable: false,
    };
  }

  if (status === "error") {
    // Sub-classify by error message content
    if (/rate.?limit|429|too many requests/i.test(errMsg)) {
      return {
        category: A2AErrorCategory.TRANSIENT,
        code: "rate_limit",
        reason: input.error ?? "rate limit",
        retriable: true,
      };
    }
    if (/context.?length|token.?limit|too.?long|maximum.?context/i.test(errMsg)) {
      return {
        category: A2AErrorCategory.PERMANENT,
        code: "context_exceeded",
        reason: input.error ?? "context exceeded",
        retriable: false,
      };
    }
    if (/overload|529|capacity|server.?error|500|502|503/i.test(errMsg)) {
      return {
        category: A2AErrorCategory.TRANSIENT,
        code: "server_overload",
        reason: input.error ?? "server overload",
        retriable: true,
      };
    }
    if (/not.?found|invalid|denied|forbidden/i.test(errMsg)) {
      return {
        category: A2AErrorCategory.PERMANENT,
        code: "request_rejected",
        reason: input.error ?? "request rejected",
        retriable: false,
      };
    }
    return {
      category: A2AErrorCategory.UNKNOWN,
      code: "error_unknown",
      reason: input.error ?? "unknown error",
      retriable: true,
    };
  }

  // status === "timeout" or other — agent is still running, retriable
  if (status === "timeout") {
    return {
      category: A2AErrorCategory.TRANSIENT,
      code: "wait_chunk_timeout",
      reason: "agent.wait chunk timeout (agent still running)",
      retriable: true,
    };
  }

  return {
    category: A2AErrorCategory.UNKNOWN,
    code: "unexpected_status",
    reason: `unexpected status: ${status}`,
    retriable: true,
  };
}

/**
 * Exponential backoff with jitter.
 *
 * Formula: min(maxMs, baseMs * 2^attempt) * random(0.5, 1.0)
 * This gives "decorrelated jitter" that prevents thundering herd.
 */
export function calculateBackoffMs(
  attempt: number,
  opts?: { baseMs?: number; maxMs?: number },
): number {
  const base = opts?.baseMs ?? 2_000;
  const max = opts?.maxMs ?? 60_000;

  const exponential = Math.min(max, base * Math.pow(2, attempt));
  // Jitter: random between 50% and 100% of exponential
  const jitter = exponential * (0.5 + Math.random() * 0.5);
  return Math.floor(jitter);
}
