/**
 * Session Tool Gate
 *
 * Per-session runtime tool permission gating.  A lead agent can grant or
 * revoke individual tools for a worker agent's session, enabling least-
 * privilege execution during plan approval flows.
 *
 * Usage:
 *   gateSessionTools(sessionKey, ["exec", "write"]);  // block exec + write
 *   approveSessionTools(sessionKey, ["exec"]);         // unblock exec only
 *   revokeSessionTools(sessionKey, ["write", "exec"]); // re-block both
 *   isToolGated(sessionKey, "exec")                    // → true/false
 *   clearSessionGates(sessionKey);                     // remove all gates
 */

type GateSet = Set<string>;

const gates = new Map<string, GateSet>();

/** Block a set of tools for a session. */
export function gateSessionTools(sessionKey: string, tools: string[]): void {
  let set = gates.get(sessionKey);
  if (!set) {
    set = new Set();
    gates.set(sessionKey, set);
  }
  for (const tool of tools) {
    set.add(tool);
  }
}

/** Unblock (approve) specific tools for a session. */
export function approveSessionTools(sessionKey: string, tools: string[]): void {
  const set = gates.get(sessionKey);
  if (!set) {
    return;
  }
  for (const tool of tools) {
    set.delete(tool);
  }
  if (set.size === 0) {
    gates.delete(sessionKey);
  }
}

/** Re-block specific tools for a session. */
export function revokeSessionTools(sessionKey: string, tools: string[]): void {
  gateSessionTools(sessionKey, tools);
}

/** Check whether a tool is currently blocked for a session. */
export function isToolGated(sessionKey: string, toolName: string): boolean {
  const set = gates.get(sessionKey);
  return set ? set.has(toolName) : false;
}

/** List all gated tools for a session. */
export function listGatedTools(sessionKey: string): string[] {
  const set = gates.get(sessionKey);
  return set ? [...set] : [];
}

/** Remove all gates for a session (cleanup on session end). */
export function clearSessionGates(sessionKey: string): void {
  gates.delete(sessionKey);
}

/** Reset all gates (for tests). */
export function resetAllGates(): void {
  gates.clear();
}
