import { describe, expect, it, vi } from "vitest";

vi.mock("../agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProviders: () => [],
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({}));

import { isAnnounceSkip, isReplySkip } from "./sessions-send-helpers.js";

describe("isReplySkip", () => {
  it("matches valid reply skip variants", () => {
    expect(isReplySkip("REPLY_SKIP")).toBe(true);
    expect(isReplySkip("reply_skip")).toBe(true);
    expect(isReplySkip("Reply_Skip")).toBe(true);
    expect(isReplySkip("REPLY_SKIP.")).toBe(true);
    expect(isReplySkip("REPLY_SKIP thanks")).toBe(true);
    expect(isReplySkip("  REPLY_SKIP  ")).toBe(true);
  });

  it("does not over-match reply skip", () => {
    expect(isReplySkip("REPLY_SKIPPED")).toBe(false);
    expect(isReplySkip("NOT REPLY_SKIP")).toBe(false);
    expect(isReplySkip("")).toBe(false);
    expect(isReplySkip(undefined)).toBe(false);
  });
});

describe("isAnnounceSkip", () => {
  it("matches valid announce skip variants", () => {
    expect(isAnnounceSkip("ANNOUNCE_SKIP")).toBe(true);
    expect(isAnnounceSkip("announce_skip")).toBe(true);
    expect(isAnnounceSkip("ANNOUNCE_SKIP.")).toBe(true);
    expect(isAnnounceSkip("ANNOUNCE_SKIP nothing to say")).toBe(true);
  });

  it("does not over-match announce skip", () => {
    expect(isAnnounceSkip("ANNOUNCE_SKIPPED")).toBe(false);
  });
});
