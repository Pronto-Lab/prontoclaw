import { describe, it, expect, beforeEach } from "vitest";
import {
  gateSessionTools,
  approveSessionTools,
  revokeSessionTools,
  isToolGated,
  listGatedTools,
  clearSessionGates,
  resetAllGates,
} from "./session-tool-gate.js";

describe("session-tool-gate", () => {
  beforeEach(() => {
    resetAllGates();
  });

  it("gates and queries tools for a session", () => {
    gateSessionTools("ses:1", ["exec", "write"]);
    expect(isToolGated("ses:1", "exec")).toBe(true);
    expect(isToolGated("ses:1", "write")).toBe(true);
    expect(isToolGated("ses:1", "read")).toBe(false);
  });

  it("approves (unblocks) specific tools", () => {
    gateSessionTools("ses:1", ["exec", "write"]);
    approveSessionTools("ses:1", ["exec"]);
    expect(isToolGated("ses:1", "exec")).toBe(false);
    expect(isToolGated("ses:1", "write")).toBe(true);
  });

  it("revokes (re-blocks) tools", () => {
    gateSessionTools("ses:1", ["exec"]);
    approveSessionTools("ses:1", ["exec"]);
    revokeSessionTools("ses:1", ["exec"]);
    expect(isToolGated("ses:1", "exec")).toBe(true);
  });

  it("lists gated tools", () => {
    gateSessionTools("ses:1", ["write", "exec"]);
    expect(listGatedTools("ses:1").toSorted()).toEqual(["exec", "write"]);
  });

  it("returns empty for unknown session", () => {
    expect(isToolGated("unknown", "exec")).toBe(false);
    expect(listGatedTools("unknown")).toEqual([]);
  });

  it("clearSessionGates removes all gates for a session", () => {
    gateSessionTools("ses:1", ["exec", "write"]);
    clearSessionGates("ses:1");
    expect(isToolGated("ses:1", "exec")).toBe(false);
    expect(listGatedTools("ses:1")).toEqual([]);
  });

  it("sessions are isolated", () => {
    gateSessionTools("ses:1", ["exec"]);
    gateSessionTools("ses:2", ["write"]);
    expect(isToolGated("ses:1", "exec")).toBe(true);
    expect(isToolGated("ses:1", "write")).toBe(false);
    expect(isToolGated("ses:2", "exec")).toBe(false);
    expect(isToolGated("ses:2", "write")).toBe(true);
  });

  it("approving all gated tools removes session entry", () => {
    gateSessionTools("ses:1", ["exec"]);
    approveSessionTools("ses:1", ["exec"]);
    // Internal: gate map should not have a leftover empty set
    expect(listGatedTools("ses:1")).toEqual([]);
  });
});
