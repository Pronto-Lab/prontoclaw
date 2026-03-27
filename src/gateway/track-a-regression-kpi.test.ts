import { describe, expect, test } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { maskConversationTitleOrPreview } from "../channels/sensitive-mask.js";
import { deriveDeterministicSessionPreview, deriveDeterministicSessionTitle } from "./session-utils.js";

type MaskRegressionCase = {
  name: string;
  input: string;
  expected: string;
  shouldMask: boolean;
};

describe("Track A regression KPI", () => {
  test("collects masking hit/false-positive KPI across miss scenarios", () => {
    const cases: MaskRegressionCase[] = [
      {
        name: "email masking",
        input: "owner=qa_test@resona.co.kr",
        expected: "owner=[redacted-email]",
        shouldMask: true,
      },
      {
        name: "phone masking",
        input: "phone=+82 10-1234-5678",
        expected: "phone=[redacted-phone]",
        shouldMask: true,
      },
      {
        name: "token masking",
        input: "token=sk-live_ABCDef123456789",
        expected: "token=[redacted-token]",
        shouldMask: true,
      },
      {
        name: "internal URL masking",
        input: "internal=http://10.0.1.25:8080/path",
        expected: "internal=[redacted-internal-url]",
        shouldMask: true,
      },
      {
        name: "public URL should remain",
        input: "external=https://docs.openclaw.ai/guide",
        expected: "external=https://docs.openclaw.ai/guide",
        shouldMask: false,
      },
      {
        name: "whatsapp id should remain",
        input: "sender=1234567890@s.whatsapp.net",
        expected: "sender=1234567890@s.whatsapp.net",
        shouldMask: false,
      },
      {
        name: "short id should remain",
        input: "ticket=1234",
        expected: "ticket=1234",
        shouldMask: false,
      },
    ];

    const outputs = cases.map((item) => ({
      ...item,
      actual: maskConversationTitleOrPreview(item.input),
    }));

    for (const item of outputs) {
      expect(item.actual, item.name).toBe(item.expected);
    }

    const maskTargets = outputs.filter((item) => item.shouldMask);
    const maskHits = maskTargets.filter((item) => item.actual === item.expected).length;
    const maskHitRate = maskTargets.length > 0 ? maskHits / maskTargets.length : 1;

    const safeTargets = outputs.filter((item) => !item.shouldMask);
    const falsePositives = safeTargets.filter((item) => item.actual !== item.input).length;
    const falsePositiveRate = safeTargets.length > 0 ? falsePositives / safeTargets.length : 0;

    expect(maskHitRate).toBe(1);
    expect(falsePositiveRate).toBe(0);
  });

  test("collects deterministic fallback KPI for failure/blank scenarios", () => {
    const scenarios: Array<{
      name: string;
      entry: SessionEntry;
      firstUserMessage: string | null;
      lastMessagePreview: string | null;
    }> = [
      {
        name: "normal conversation",
        entry: { subject: "General", updatedAt: Date.now() } as SessionEntry,
        firstUserMessage: "Hello team",
        lastMessagePreview: "Latest update",
      },
      {
        name: "blank metadata and transcript",
        entry: { subject: "   ", displayName: "   ", updatedAt: Date.now() } as SessionEntry,
        firstUserMessage: null,
        lastMessagePreview: null,
      },
      {
        name: "masked but usable first message",
        entry: { subject: "   ", displayName: "   ", updatedAt: Date.now() } as SessionEntry,
        firstUserMessage: "email qa_test@resona.co.kr",
        lastMessagePreview: null,
      },
      {
        name: "subject only",
        entry: { subject: "Operations", updatedAt: Date.now() } as SessionEntry,
        firstUserMessage: null,
        lastMessagePreview: null,
      },
    ];

    const evaluated = scenarios.map((scenario) => {
      const title = deriveDeterministicSessionTitle(scenario.entry, scenario.firstUserMessage);
      const preview = deriveDeterministicSessionPreview({
        entry: scenario.entry,
        firstUserMessage: scenario.firstUserMessage,
        lastMessagePreview: scenario.lastMessagePreview,
        fallbackTitle: title,
      });
      return { ...scenario, title, preview };
    });

    for (const row of evaluated) {
      expect(row.title.length > 0, `${row.name}: title must not be empty`).toBe(true);
      expect(row.preview.length > 0, `${row.name}: preview must not be empty`).toBe(true);
    }

    const titleFallbackCount = evaluated.filter((row) => row.title === "새 대화").length;
    const previewFallbackCount = evaluated.filter((row) => row.preview === "안전 텍스트").length;

    const titleGenerationSuccessRate =
      (evaluated.length - titleFallbackCount) / Math.max(1, evaluated.length);
    const previewGenerationSuccessRate =
      (evaluated.length - previewFallbackCount) / Math.max(1, evaluated.length);

    expect(titleFallbackCount).toBe(1);
    expect(previewFallbackCount).toBe(1);
    expect(titleGenerationSuccessRate).toBe(0.75);
    expect(previewGenerationSuccessRate).toBe(0.75);
  });
});
