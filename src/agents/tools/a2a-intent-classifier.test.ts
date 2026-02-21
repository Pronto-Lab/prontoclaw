import { describe, it, expect } from "vitest";
import {
  classifyMessageIntent,
  resolveEffectivePingPongTurns,
  shouldTerminatePingPong,
  calculateSimilarity,
  shouldRunAnnounce,
} from "./a2a-intent-classifier.js";

describe("classifyMessageIntent", () => {
  it("detects [NO_REPLY_NEEDED] as notification", () => {
    const result = classifyMessageIntent("Task done [NO_REPLY_NEEDED]");
    expect(result.intent).toBe("notification");
    expect(result.suggestedTurns).toBe(0);
    expect(result.confidence).toBe(1.0);
  });

  it("detects [NOTIFICATION] as notification", () => {
    const result = classifyMessageIntent("[NOTIFICATION] Build succeeded");
    expect(result.intent).toBe("notification");
    expect(result.suggestedTurns).toBe(0);
  });

  it("detects Korean forwarding/sharing notification patterns", () => {
    expect(classifyMessageIntent("전달합니다").intent).toBe("notification");
    expect(classifyMessageIntent("공유합니다").intent).toBe("notification");
    expect(classifyMessageIntent("알림: 서버 재시작").intent).toBe("notification");
  });

  it("detects [URGENT] as escalation", () => {
    const result = classifyMessageIntent("[URGENT] Server is down!");
    expect(result.intent).toBe("escalation");
    expect(result.suggestedTurns).toBe(0);
    expect(result.confidence).toBe(1.0);
  });

  it("detects [ESCALATION] as escalation", () => {
    const result = classifyMessageIntent("[ESCALATION] Critical bug found");
    expect(result.intent).toBe("escalation");
  });

  it("detects result report patterns", () => {
    expect(classifyMessageIntent("작업을 완료했습니다").intent).toBe("result_report");
    expect(classifyMessageIntent("[outcome] success").intent).toBe("result_report");
    expect(classifyMessageIntent("분석 결과를 보고합니다").intent).toBe("result_report");
    expect(classifyMessageIntent("Task completed successfully").intent).toBe("result_report");
  });

  it("detects question patterns", () => {
    expect(classifyMessageIntent("이 코드 어떻게 작동해?").intent).toBe("question");
    expect(classifyMessageIntent("Can you help me with this?").intent).toBe("question");
  });

  it("detects request patterns", () => {
    const review = classifyMessageIntent("이 코드 검토해줘");
    expect(review.intent).toBe("request");
    expect(review.suggestedTurns).toBe(3);

    const handleIt = classifyMessageIntent("이거 처리해주세요");
    expect(handleIt.intent).toBe("request");
    expect(handleIt.suggestedTurns).toBe(3);

    const analyze = classifyMessageIntent("분석해줘");
    expect(analyze.intent).toBe("request");
    expect(analyze.suggestedTurns).toBe(3);

    const ask = classifyMessageIntent("부탁드립니다");
    expect(ask.intent).toBe("request");
    expect(ask.suggestedTurns).toBe(3);

    const confirm = classifyMessageIntent("확인해줘");
    expect(confirm.intent).toBe("request");
    expect(confirm.suggestedTurns).toBe(3);
  });

  it("detects collaboration patterns", () => {
    expect(classifyMessageIntent("같이 검토해보자").intent).toBe("collaboration");
    expect(classifyMessageIntent("의견 좀 줘").intent).toBe("collaboration");
    expect(classifyMessageIntent("Let's discuss the approach").intent).toBe("collaboration");
  });

  it("returns collaboration suggestedTurns=-1 (use config)", () => {
    const result = classifyMessageIntent("함께 논의해볼까요");
    expect(result.intent).toBe("collaboration");
    expect(result.suggestedTurns).toBe(-1);
  });

  it("defaults to collaboration for ambiguous messages", () => {
    const result = classifyMessageIntent("Here is some information about X");
    expect(result.intent).toBe("collaboration");
    expect(result.confidence).toBe(0.5);
  });
});

describe("resolveEffectivePingPongTurns", () => {
  it("returns 0 when skipPingPong is true", () => {
    const result = resolveEffectivePingPongTurns({
      configMaxTurns: 5,
      classifiedIntent: { intent: "collaboration", suggestedTurns: -1, confidence: 0.7 },
      explicitSkipPingPong: true,
    });
    expect(result).toBe(0);
  });

  it("returns 0 when suggestedTurns is 0", () => {
    const result = resolveEffectivePingPongTurns({
      configMaxTurns: 5,
      classifiedIntent: { intent: "notification", suggestedTurns: 0, confidence: 1.0 },
      explicitSkipPingPong: false,
    });
    expect(result).toBe(0);
  });

  it("returns configMaxTurns when suggestedTurns is -1", () => {
    const result = resolveEffectivePingPongTurns({
      configMaxTurns: 7,
      classifiedIntent: { intent: "collaboration", suggestedTurns: -1, confidence: 0.7 },
      explicitSkipPingPong: false,
    });
    expect(result).toBe(7);
  });

  it("returns min of suggested and config", () => {
    const result = resolveEffectivePingPongTurns({
      configMaxTurns: 3,
      classifiedIntent: { intent: "question", suggestedTurns: 5, confidence: 0.8 },
      explicitSkipPingPong: false,
    });
    expect(result).toBe(3);
  });

  it("returns suggested when less than config", () => {
    const result = resolveEffectivePingPongTurns({
      configMaxTurns: 10,
      classifiedIntent: { intent: "result_report", suggestedTurns: 1, confidence: 0.8 },
      explicitSkipPingPong: false,
    });
    expect(result).toBe(1);
  });
});

describe("shouldTerminatePingPong", () => {
  it("detects repetition (high similarity to previous reply)", () => {
    const result = shouldTerminatePingPong({
      replyText: "The server is running on port 8080 with default configuration",
      turn: 2,
      maxTurns: 5,
      previousReplies: ["The server is running on port 8080 with default configuration settings"],
    });
    expect(result.terminate).toBe(true);
    expect(result.reason).toBe("repetition_detected");
  });

  it("does not flag dissimilar replies as repetition", () => {
    const result = shouldTerminatePingPong({
      replyText: "I will deploy the fix to production",
      turn: 2,
      maxTurns: 5,
      previousReplies: ["The database migration has been completed successfully"],
    });
    expect(result.terminate).toBe(false);
  });

  it("detects minimal content (short non-question)", () => {
    const result = shouldTerminatePingPong({
      replyText: "OK",
      turn: 1,
      maxTurns: 5,
      previousReplies: [],
    });
    expect(result.terminate).toBe(true);
    expect(result.reason).toBe("minimal_content");
  });

  it("does not terminate on short question", () => {
    const result = shouldTerminatePingPong({
      replyText: "Why?",
      turn: 1,
      maxTurns: 5,
      previousReplies: [],
    });
    expect(result.terminate).toBe(false);
  });

  it("detects conclusion signals (Korean)", () => {
    expect(
      shouldTerminatePingPong({
        replyText: "알겠습니다. 진행하겠습니다.",
        turn: 2,
        maxTurns: 5,
        previousReplies: ["이렇게 구현하면 됩니다"],
      }).terminate,
    ).toBe(true);

    expect(
      shouldTerminatePingPong({
        replyText: "확인했습니다",
        turn: 2,
        maxTurns: 5,
        previousReplies: [],
      }).terminate,
    ).toBe(true);
  });

  it("detects conclusion signals (English)", () => {
    expect(
      shouldTerminatePingPong({
        replyText: "Got it, I'll proceed with the implementation",
        turn: 2,
        maxTurns: 5,
        previousReplies: ["Here's how to implement it"],
      }).terminate,
    ).toBe(true);

    expect(
      shouldTerminatePingPong({
        replyText: "Noted. Will do.",
        turn: 2,
        maxTurns: 5,
        previousReplies: [],
      }).terminate,
    ).toBe(true);
  });

  it("allows substantive replies to continue", () => {
    const result = shouldTerminatePingPong({
      replyText:
        "I've reviewed the code and found several issues. First, the authentication middleware doesn't handle expired tokens properly. Second, the database queries could be optimized with proper indexing.",
      turn: 1,
      maxTurns: 5,
      previousReplies: [],
    });
    expect(result.terminate).toBe(false);
  });

  it("works with empty previous replies", () => {
    const result = shouldTerminatePingPong({
      replyText:
        "This is a detailed technical response with enough content to continue the discussion.",
      turn: 1,
      maxTurns: 5,
      previousReplies: [],
    });
    expect(result.terminate).toBe(false);
  });
});

describe("calculateSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(calculateSimilarity("hello world", "hello world")).toBe(1.0);
  });

  it("returns 0 for completely different strings", () => {
    expect(calculateSimilarity("hello world", "foo bar baz")).toBe(0);
  });

  it("returns high similarity for nearly identical strings", () => {
    const sim = calculateSimilarity(
      "the server is running on port 8080",
      "the server is running on port 8080 with defaults",
    );
    expect(sim).toBeGreaterThan(0.7);
  });

  it("returns 1.0 for two empty strings", () => {
    expect(calculateSimilarity("", "")).toBe(1);
  });

  it("returns 0 when one string is empty", () => {
    expect(calculateSimilarity("hello", "")).toBe(0);
    expect(calculateSimilarity("", "world")).toBe(0);
  });

  it("is case insensitive", () => {
    expect(calculateSimilarity("Hello World", "hello world")).toBe(1.0);
  });
});

describe("shouldRunAnnounce", () => {
  it("returns false when no announceTarget", () => {
    expect(shouldRunAnnounce({ announceTarget: null })).toBe(false);
  });

  it("returns false when latestReply is empty", () => {
    expect(
      shouldRunAnnounce({ announceTarget: { channel: "discord", to: "123" }, latestReply: "" }),
    ).toBe(false);
  });

  it("returns false when channel is internal", () => {
    expect(
      shouldRunAnnounce({
        announceTarget: { channel: "internal", to: "123" },
        latestReply: "Hello",
      }),
    ).toBe(false);
  });

  it("returns true for valid announce conditions", () => {
    expect(
      shouldRunAnnounce({
        announceTarget: { channel: "discord", to: "123" },
        latestReply: "Task completed successfully",
      }),
    ).toBe(true);
  });
});
