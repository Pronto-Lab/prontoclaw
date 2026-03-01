import type { A2AConcurrencyConfig } from "../agents/a2a-concurrency.js";
import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
// Keep depth-1 subagents as leaves unless config explicitly opts into nesting.
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;

export function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_AGENT_MAX_CONCURRENT;
}

export function resolveSubagentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.subagents?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_SUBAGENT_MAX_CONCURRENT;
}

export function resolveA2AConcurrencyConfig(
  cfg?: ReturnType<typeof import("./config.js").loadConfig>,
): Partial<A2AConcurrencyConfig> | undefined {
  const raw = (cfg?.agents?.defaults as Record<string, unknown>)?.a2aConcurrency;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const result: Partial<A2AConcurrencyConfig> = {};
  const obj = raw as Record<string, unknown>;
  if (typeof obj.maxConcurrentFlows === "number" && Number.isFinite(obj.maxConcurrentFlows)) {
    result.maxConcurrentFlows = Math.max(1, Math.floor(obj.maxConcurrentFlows));
  }
  if (typeof obj.queueTimeoutMs === "number" && Number.isFinite(obj.queueTimeoutMs)) {
    result.queueTimeoutMs = Math.max(0, Math.floor(obj.queueTimeoutMs));
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
