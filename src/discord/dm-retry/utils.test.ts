import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { DM_RETRY_DEFAULTS, isAgentBotId, resolveDmRetryConfig, truncateText } from "./utils.js";

describe("dm-retry utils", () => {
  describe("resolveDmRetryConfig", () => {
    it("returns defaults when no config provided", () => {
      const result = resolveDmRetryConfig(undefined);

      expect(result).toEqual(DM_RETRY_DEFAULTS);
    });

    it("returns defaults when discord config is empty", () => {
      const cfg = { channels: {} } as OpenClawConfig;

      const result = resolveDmRetryConfig(cfg);

      expect(result).toEqual(DM_RETRY_DEFAULTS);
    });

    it("uses global discord dm retry config", () => {
      const cfg = {
        channels: {
          discord: {
            dm: {
              retry: {
                enabled: true,
                timeoutMs: 120000,
                maxAttempts: 5,
              },
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveDmRetryConfig(cfg);

      expect(result.enabled).toBe(true);
      expect(result.timeoutMs).toBe(120000);
      expect(result.maxAttempts).toBe(5);
      expect(result.backoffMs).toBe(DM_RETRY_DEFAULTS.backoffMs);
      expect(result.notifyOnFailure).toBe(DM_RETRY_DEFAULTS.notifyOnFailure);
    });

    it("merges account-level config over global config", () => {
      const cfg = {
        channels: {
          discord: {
            dm: {
              retry: {
                enabled: true,
                timeoutMs: 120000,
              },
            },
            accounts: {
              myAccount: {
                dm: {
                  retry: {
                    timeoutMs: 60000,
                    maxAttempts: 2,
                  },
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveDmRetryConfig(cfg, "myAccount");

      expect(result.timeoutMs).toBe(60000);
      expect(result.maxAttempts).toBe(2);
    });
  });

  describe("isAgentBotId", () => {
    it("returns false when no agents list", () => {
      const cfg = {} as OpenClawConfig;

      const result = isAgentBotId("12345", cfg);

      expect(result).toBe(false);
    });

    it("returns false when no discord config", () => {
      const cfg = {
        agents: { list: [{ id: "main" }] },
      } as unknown as OpenClawConfig;

      const result = isAgentBotId("12345", cfg);

      expect(result).toBe(false);
    });

    it("returns true when userId matches an agent botId", () => {
      const cfg = {
        agents: {
          list: [
            { id: "main", discord: { botId: "111111" } },
            { id: "eden", discord: { botId: "222222" } },
          ],
        },
        channels: {
          discord: {
            token: "test-token",
          },
        },
      } as unknown as OpenClawConfig;

      expect(isAgentBotId("222222", cfg)).toBe(true);
    });

    it("returns false when userId does not match any agent", () => {
      const cfg = {
        agents: {
          list: [{ id: "main", discord: { botId: "111111" } }],
        },
        channels: {
          discord: {
            token: "test-token",
          },
        },
      } as unknown as OpenClawConfig;

      expect(isAgentBotId("999999", cfg)).toBe(false);
    });
  });

  describe("truncateText", () => {
    it("returns full text if under limit", () => {
      const result = truncateText("Hello world", 50);

      expect(result).toBe("Hello world");
    });

    it("returns full text if exactly at limit", () => {
      const result = truncateText("12345", 5);

      expect(result).toBe("12345");
    });

    it("truncates with ellipsis if over limit", () => {
      const result = truncateText("Hello world!", 8);

      expect(result).toBe("Hello...");
      expect(result.length).toBe(8);
    });

    it("handles empty string", () => {
      const result = truncateText("", 10);

      expect(result).toBe("");
    });
  });
});
