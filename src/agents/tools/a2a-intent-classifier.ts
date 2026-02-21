/**
 * A2A Message Intent Classifier & Ping-Pong Optimization (Design #4)
 *
 * Classifies incoming A2A messages by intent to determine optimal
 * ping-pong turn count, and provides system-level early termination
 * for the ping-pong loop.
 */

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

export type A2AMessageIntent =
  | "notification" // Alert, report — no reply needed
  | "question" // Simple question — 1 turn confirmation
  | "request"
  | "collaboration" // Discussion/collab — multi-turn
  | "escalation" // Urgent — immediate announce
  | "result_report"; // Work result — 1 turn feedback

export interface IntentClassification {
  intent: A2AMessageIntent;
  /** -1 = use config default, 0 = skip, N = specific turn count */
  suggestedTurns: number;
  confidence: number;
}

export function classifyMessageIntent(message: string): IntentClassification {
  // 1. Explicit tags (backward-compatible)
  if (/\[NO_REPLY_NEEDED\]|\[NOTIFICATION\]|전달합니다|공유합니다|알림:/i.test(message)) {
    return { intent: "notification", suggestedTurns: 0, confidence: 1.0 };
  }
  if (/\[URGENT\]|\[ESCALATION\]/i.test(message)) {
    return { intent: "escalation", suggestedTurns: 0, confidence: 1.0 };
  }

  // 2. Pattern-based classification (ORDER MATTERS — check broad categories first)

  // Result report patterns
  if (
    /\[outcome\]|\[result\]|작업.*완료|결과.*보고|분석.*결과|completed|finished|done/i.test(message)
  ) {
    return { intent: "result_report", suggestedTurns: 1, confidence: 0.8 };
  }

  if (
    /해줘|해주세요|해줄래|봐줘|봐주세요|처리해|부탁해|부탁드|진행해줘|작성해줘|분석해줘|검토해줘|수정해줘|생성해줘|만들어줘|보내줘|알아봐줘/i.test(
      message,
    )
  ) {
    return { intent: "request", suggestedTurns: 3, confidence: 0.75 };
  }

  // Collaboration patterns — MUST be checked BEFORE question patterns.
  // Messages that ask for discussion/opinions often contain question words (어떻게)
  // but the primary intent is collaboration, not a simple question.
  if (
    /논의|토론|설계하자|같이|함께|의견.*줘|의견.*들려|의견.*말해|피드백|리뷰|검토|합의|조율|상의|브레인스토밍|let'?s discuss|review together|brainstorm|collaborate|work together|let'?s figure out|what do you think/i.test(
      message,
    )
  ) {
    return { intent: "collaboration", suggestedTurns: -1, confidence: 0.8 };
  }

  // Question patterns — simple one-shot questions (not discussions)
  if (/\?$|어떻게|어디에|뭐가|알려줘|can you|could you|please/i.test(message)) {
    return { intent: "question", suggestedTurns: 1, confidence: 0.7 };
  }

  // Default: collaboration (prefer multi-turn — agents can always REPLY_SKIP to end early)
  return { intent: "collaboration", suggestedTurns: -1, confidence: 0.5 };
}

// ---------------------------------------------------------------------------
// Effective turn count resolution
// ---------------------------------------------------------------------------

export function resolveEffectivePingPongTurns(params: {
  configMaxTurns: number;
  classifiedIntent: IntentClassification;
  explicitSkipPingPong: boolean;
}): number {
  if (params.explicitSkipPingPong) {
    return 0;
  }
  if (params.classifiedIntent.suggestedTurns === 0) {
    return 0;
  }
  if (params.classifiedIntent.suggestedTurns === -1) {
    return params.configMaxTurns;
  }
  return Math.min(params.classifiedIntent.suggestedTurns, params.configMaxTurns);
}

// ---------------------------------------------------------------------------
// System-level early termination
// ---------------------------------------------------------------------------

export interface TerminationResult {
  terminate: boolean;
  reason: string;
}

export function shouldTerminatePingPong(params: {
  replyText: string;
  turn: number;
  maxTurns: number;
  previousReplies: string[];
}): TerminationResult {
  const trimmed = params.replyText.trim();

  // 1. Repetition detection — current reply too similar to previous
  if (params.previousReplies.length > 0) {
    const lastReply = params.previousReplies[params.previousReplies.length - 1];
    if (lastReply && calculateSimilarity(trimmed, lastReply) > 0.85) {
      return { terminate: true, reason: "repetition_detected" };
    }
  }

  // 2. Minimal content — no substantive response (short + not a question)
  if (trimmed.length < 20 && !/\?/.test(trimmed)) {
    return { terminate: true, reason: "minimal_content" };
  }

  // 3. Conclusion signal patterns
  if (
    /^(알겠습니다|확인했습니다|감사합니다|네,?\s*이해했습니다|완료|understood|got it|thanks|noted)/i.test(
      trimmed,
    )
  ) {
    return { terminate: true, reason: "conclusion_detected" };
  }

  return { terminate: false, reason: "" };
}

// ---------------------------------------------------------------------------
// Similarity (Jaccard word-level)
// ---------------------------------------------------------------------------

export function calculateSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) {
    return 1;
  }
  if (wordsA.size === 0 || wordsB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) {
      intersection++;
    }
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Announce gating
// ---------------------------------------------------------------------------

export function shouldRunAnnounce(params: {
  announceTarget: { channel: string; to: string } | null;
  latestReply?: string;
  requesterSessionKey?: string;
  targetSessionKey?: string;
}): boolean {
  if (!params.announceTarget) {
    return false;
  }
  if (!params.latestReply?.trim()) {
    return false;
  }
  if (params.announceTarget.channel === "internal") {
    return false;
  }
  // Skip announce for internal agent-to-agent conversations.
  // Both parties are agents — no need to post results to external channels.
  if (params.requesterSessionKey && params.targetSessionKey) {
    const isRequesterAgent = /^agent:[^:]+:(main|a2a:|subagent:)/i.test(params.requesterSessionKey);
    const isTargetAgent = /^agent:[^:]+:(main|a2a:|subagent:)/i.test(params.targetSessionKey);
    if (isRequesterAgent && isTargetAgent) {
      return false;
    }
  }
  return true;
}
