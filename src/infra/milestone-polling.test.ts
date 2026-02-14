import { describe, it, expect, beforeEach } from "vitest";

// Re-implement simpleHash from scripts/task-monitor-server.ts
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = (hash << 5) - hash + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

// Mini version of polling detection logic
function detectMilestoneChange(body: string, state: { lastHash: string }): boolean {
  const hash = simpleHash(body);
  const changed = hash !== state.lastHash && state.lastHash !== "";
  state.lastHash = hash;
  return changed;
}

describe("simpleHash", () => {
  it("returns consistent hash for same input", () => {
    const hash1 = simpleHash("hello");
    const hash2 = simpleHash("hello");
    expect(hash1).toBe(hash2);
  });

  it("returns different hash for different input", () => {
    const hash1 = simpleHash("hello");
    const hash2 = simpleHash("world");
    expect(hash1).not.toBe(hash2);
  });

  it("returns string type", () => {
    const hash = simpleHash("test");
    expect(typeof hash).toBe("string");
  });

  it("handles empty string", () => {
    const hash = simpleHash("");
    expect(hash).toBe("0");
  });

  it("returns base-36 encoded string", () => {
    const hash = simpleHash("test data with special chars !@#$%");
    // Base-36 should only contain [0-9a-z] and optionally minus sign for negative numbers
    expect(/^-?[0-9a-z]+$/.test(hash)).toBe(true);
  });
});

describe("milestone polling detection logic", () => {
  it("detects hash change", () => {
    const state = { lastHash: "" };

    // First call: no change detected (lastHash is empty)
    const firstChange = detectMilestoneChange("data1", state);
    expect(firstChange).toBe(false);

    // Second call: change detected (hash changed from data1 to data2)
    const secondChange = detectMilestoneChange("data2", state);
    expect(secondChange).toBe(true);
  });

  it("same data produces no change detection", () => {
    const state = { lastHash: "" };

    // First call: no change detected (lastHash is empty)
    const firstChange = detectMilestoneChange("same data", state);
    expect(firstChange).toBe(false);

    // Second call with same data: no change detected (hash is the same)
    const secondChange = detectMilestoneChange("same data", state);
    expect(secondChange).toBe(false);
  });
});
