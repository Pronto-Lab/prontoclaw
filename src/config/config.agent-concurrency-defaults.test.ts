import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  DEFAULT_A2A_MAX_CONCURRENT_FLOWS,
  DEFAULT_A2A_QUEUE_TIMEOUT_MS,
  resolveAgentMaxConcurrent,
  resolveSubagentMaxConcurrent,
  resolveA2AConcurrencyConfig,
} from "./agent-limits.js";
import { loadConfig } from "./config.js";
import { withTempHome } from "./test-helpers.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("agent concurrency defaults", () => {
  it("resolves defaults when unset", () => {
    expect(resolveAgentMaxConcurrent({})).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(resolveSubagentMaxConcurrent({})).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });

  it("clamps invalid values to at least 1", () => {
    const cfg = {
      agents: {
        defaults: {
          maxConcurrent: 0,
          subagents: { maxConcurrent: -3 },
        },
      },
    };
    expect(resolveAgentMaxConcurrent(cfg)).toBe(1);
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(1);
  });

  it("accepts subagent spawn depth and per-agent child limits", () => {
    const parsed = OpenClawSchema.parse({
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
            maxChildrenPerAgent: 7,
          },
        },
      },
    });

    expect(parsed.agents?.defaults?.subagents?.maxSpawnDepth).toBe(2);
    expect(parsed.agents?.defaults?.subagents?.maxChildrenPerAgent).toBe(7);
  });

  it("injects defaults on load", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({}, null, 2),
        "utf-8",
      );

      const cfg = loadConfig();

      expect(cfg.agents?.defaults?.maxConcurrent).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
      expect(cfg.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
    });
  });

  // ─── A2A Concurrency Config ───

  describe("resolveA2AConcurrencyConfig", () => {
    it("resolves defaults when unset", () => {
      const result = resolveA2AConcurrencyConfig({});
      expect(result.maxConcurrentFlows).toBe(DEFAULT_A2A_MAX_CONCURRENT_FLOWS);
      expect(result.queueTimeoutMs).toBe(DEFAULT_A2A_QUEUE_TIMEOUT_MS);
    });

    it("resolves defaults when a2aConcurrency is undefined", () => {
      const cfg = { agents: { defaults: {} } };
      const result = resolveA2AConcurrencyConfig(cfg);
      expect(result.maxConcurrentFlows).toBe(3);
      expect(result.queueTimeoutMs).toBe(30_000);
    });

    it("accepts valid custom values", () => {
      const cfg = {
        agents: {
          defaults: {
            a2aConcurrency: {
              maxConcurrentFlows: 5,
              queueTimeoutMs: 60_000,
            },
          },
        },
      };
      const result = resolveA2AConcurrencyConfig(cfg);
      expect(result.maxConcurrentFlows).toBe(5);
      expect(result.queueTimeoutMs).toBe(60_000);
    });

    it("clamps maxConcurrentFlows to at least 1", () => {
      const cfg = {
        agents: {
          defaults: {
            a2aConcurrency: { maxConcurrentFlows: 0 },
          },
        },
      };
      const result = resolveA2AConcurrencyConfig(cfg);
      expect(result.maxConcurrentFlows).toBe(1);
    });

    it("clamps queueTimeoutMs to at least 1000", () => {
      const cfg = {
        agents: {
          defaults: {
            a2aConcurrency: { queueTimeoutMs: 100 },
          },
        },
      };
      const result = resolveA2AConcurrencyConfig(cfg);
      expect(result.queueTimeoutMs).toBe(1000);
    });

    it("ignores non-numeric values and uses defaults", () => {
      const cfg = {
        agents: {
          defaults: {
            a2aConcurrency: {
              maxConcurrentFlows: "invalid" as unknown as number,
              queueTimeoutMs: NaN,
            },
          },
        },
      };
      const result = resolveA2AConcurrencyConfig(cfg);
      expect(result.maxConcurrentFlows).toBe(DEFAULT_A2A_MAX_CONCURRENT_FLOWS);
      expect(result.queueTimeoutMs).toBe(DEFAULT_A2A_QUEUE_TIMEOUT_MS);
    });

    it("floors fractional values", () => {
      const cfg = {
        agents: {
          defaults: {
            a2aConcurrency: {
              maxConcurrentFlows: 2.7,
              queueTimeoutMs: 15_500.9,
            },
          },
        },
      };
      const result = resolveA2AConcurrencyConfig(cfg);
      expect(result.maxConcurrentFlows).toBe(2);
      expect(result.queueTimeoutMs).toBe(15_500);
    });
  });
});
