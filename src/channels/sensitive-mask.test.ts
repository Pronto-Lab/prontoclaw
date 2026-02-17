import { describe, expect, it } from "vitest";
import { maskConversationTitleOrPreview } from "./sensitive-mask.js";

describe("maskConversationTitleOrPreview", () => {
  it("masks emails", () => {
    const input = "Contact me at qa_test@resona.co.kr";
    expect(maskConversationTitleOrPreview(input)).toBe("Contact me at [redacted-email]");
  });

  it("masks phone-like values only when they are long enough", () => {
    expect(maskConversationTitleOrPreview("support: +82 10-1234-5678")).toBe(
      "support: [redacted-phone]",
    );
    expect(maskConversationTitleOrPreview("id:42")).toBe("id:42");
  });

  it("masks JWT and bearer tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMDAwMTIifQ.sgnatureValue123";
    const bearer = `Bearer ${jwt}`;

    expect(maskConversationTitleOrPreview(jwt)).toBe("[redacted-token]");
    expect(maskConversationTitleOrPreview(bearer)).toBe("Bearer [redacted-token]");
  });

  it("masks prefixed API tokens", () => {
    const input = "token=sk-live_ABCDef123456789";
    expect(maskConversationTitleOrPreview(input)).toBe("token=[redacted-token]");
  });

  it("masks internal URLs but leaves public URLs", () => {
    const input = "internal=http://10.0.1.25:8080/path?x=1 external=https://docs.openclaw.ai/guide";
    expect(maskConversationTitleOrPreview(input)).toBe(
      "internal=[redacted-internal-url] external=https://docs.openclaw.ai/guide",
    );
  });

  it("supports selective masking via options", () => {
    const input = "qa_test@resona.co.kr";
    expect(maskConversationTitleOrPreview(input, { maskEmails: false })).toBe(input);
  });
});
