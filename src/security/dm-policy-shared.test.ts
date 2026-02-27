import { describe, expect, it } from "vitest";
import { resolveDmAllowState } from "./dm-policy-shared.js";

describe("security/dm-policy-shared", () => {
  it("normalizes config + store allow entries and counts distinct senders", async () => {
    const state = await resolveDmAllowState({
      provider: "telegram",
      accountId: "default",
      allowFrom: [" * ", " alice ", "ALICE", "bob"],
      normalizeEntry: (value) => value.toLowerCase(),
      readStore: async (_provider, _accountId) => [" Bob ", "carol", ""],
    });
    expect(state.configAllowFrom).toEqual(["*", "alice", "ALICE", "bob"]);
    expect(state.hasWildcard).toBe(true);
    expect(state.allowCount).toBe(3);
    expect(state.isMultiUserDm).toBe(true);
  });

  it("handles empty allowlists and store failures", async () => {
    const state = await resolveDmAllowState({
      provider: "slack",
      accountId: "default",
      allowFrom: undefined,
      readStore: async (_provider, _accountId) => {
        throw new Error("offline");
      },
    });
    expect(state.configAllowFrom).toEqual([]);
    expect(state.hasWildcard).toBe(false);
    expect(state.allowCount).toBe(0);
    expect(state.isMultiUserDm).toBe(false);
  });
});
