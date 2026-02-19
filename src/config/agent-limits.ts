import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;

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

export const DEFAULT_NESTED_MAX_CONCURRENT = 8;

export function resolveNestedMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.nested?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_NESTED_MAX_CONCURRENT;
}

// ─── A2A Concurrency Gate ───

export const DEFAULT_A2A_MAX_CONCURRENT_FLOWS = 3;
export const DEFAULT_A2A_QUEUE_TIMEOUT_MS = 30_000;

export function resolveA2AConcurrencyConfig(cfg?: OpenClawConfig): {
  maxConcurrentFlows: number;
  queueTimeoutMs: number;
} {
  const raw = cfg?.agents?.defaults?.a2aConcurrency;
  const maxConcurrentFlows =
    typeof raw?.maxConcurrentFlows === "number" && Number.isFinite(raw.maxConcurrentFlows)
      ? Math.max(1, Math.floor(raw.maxConcurrentFlows))
      : DEFAULT_A2A_MAX_CONCURRENT_FLOWS;
  const queueTimeoutMs =
    typeof raw?.queueTimeoutMs === "number" && Number.isFinite(raw.queueTimeoutMs)
      ? Math.max(1000, Math.floor(raw.queueTimeoutMs))
      : DEFAULT_A2A_QUEUE_TIMEOUT_MS;
  return { maxConcurrentFlows, queueTimeoutMs };
}
