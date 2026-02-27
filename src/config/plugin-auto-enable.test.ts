import { describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";

/** Helper to build a minimal PluginManifestRegistry for testing. */
function makeRegistry(plugins: Array<{ id: string; channels: string[] }>): PluginManifestRegistry {
  return {
    plugins: plugins.map((p) => ({
      id: p.id,
      channels: p.channels,
      providers: [],
      skills: [],
      origin: "config" as const,
      rootDir: `/fake/${p.id}`,
      source: `/fake/${p.id}/index.js`,
      manifestPath: `/fake/${p.id}/openclaw.plugin.json`,
    })),
    diagnostics: [],
  };
}

describe("applyPluginAutoEnable", () => {
  it("auto-enables channel plugins and updates allowlist", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { allow: ["telegram"] },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "slack"]);
    expect(result.changes.join("\n")).toContain("Slack configured, enabled automatically.");
  });

  it("respects explicit disable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { entries: { slack: { enabled: false } } },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it("auto-enables irc when configured via env", () => {
    const result = applyPluginAutoEnable({
      config: {},
      env: {
        IRC_HOST: "irc.libera.chat",
        IRC_NICK: "openclaw-bot",
      },
    });

    expect(result.config.plugins?.entries?.irc?.enabled).toBe(true);
    expect(result.changes.join("\n")).toContain("IRC configured, enabled automatically.");
  });

  it("auto-enables provider auth plugins when profiles exist", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "google-antigravity:default": {
              provider: "google-antigravity",
              mode: "oauth",
            },
          },
        },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.["google-antigravity-auth"]?.enabled).toBe(true);
  });

  it("auto-enables acpx plugin when ACP is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        acp: {
          enabled: true,
        },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.acpx?.enabled).toBe(true);
    expect(result.changes.join("\n")).toContain("ACP runtime configured, enabled automatically.");
  });

  it("does not auto-enable acpx when a different ACP backend is configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        acp: {
          enabled: true,
          backend: "custom-runtime",
        },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.acpx?.enabled).toBeUndefined();
  });

  it("skips when plugins are globally disabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { enabled: false },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  describe("third-party channel plugins (pluginId ≠ channelId)", () => {
    it("uses the plugin manifest id, not the channel id, for plugins.entries", () => {
      // Reproduces: https://github.com/openclaw/openclaw/issues/25261
      // Plugin "apn-channel" declares channels: ["apn"]. Doctor must write
      // plugins.entries["apn-channel"], not plugins.entries["apn"].
      const result = applyPluginAutoEnable({
        config: {
          channels: { apn: { someKey: "value" } },
        },
        env: {},
        manifestRegistry: makeRegistry([{ id: "apn-channel", channels: ["apn"] }]),
      });

      expect(result.config.plugins?.entries?.["apn-channel"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.["apn"]).toBeUndefined();
      expect(result.changes.join("\n")).toContain("apn configured, enabled automatically.");
    });

    it("does not double-enable when plugin is already enabled under its plugin id", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { apn: { someKey: "value" } },
          plugins: { entries: { "apn-channel": { enabled: true } } },
        },
        env: {},
        manifestRegistry: makeRegistry([{ id: "apn-channel", channels: ["apn"] }]),
      });

      expect(result.changes).toEqual([]);
    });

    it("respects explicit disable of the plugin by its plugin id", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { apn: { someKey: "value" } },
          plugins: { entries: { "apn-channel": { enabled: false } } },
        },
        env: {},
        manifestRegistry: makeRegistry([{ id: "apn-channel", channels: ["apn"] }]),
      });

      expect(result.config.plugins?.entries?.["apn-channel"]?.enabled).toBe(false);
      expect(result.changes).toEqual([]);
    });

    it("falls back to channel key as plugin id when no installed manifest declares the channel", () => {
      // Without a matching manifest entry, behavior is unchanged (backward compat).
      const result = applyPluginAutoEnable({
        config: {
          channels: { "unknown-chan": { someKey: "value" } },
        },
        env: {},
        manifestRegistry: makeRegistry([]),
      });

      expect(result.config.plugins?.entries?.["unknown-chan"]?.enabled).toBe(true);
    });
  });

  describe("preferOver channel prioritization", () => {
    it("prefers bluebubbles: skips imessage auto-configure when both are configured", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBeUndefined();
      expect(result.changes.join("\n")).toContain("bluebubbles configured, enabled automatically.");
      expect(result.changes.join("\n")).not.toContain(
        "iMessage configured, enabled automatically.",
      );
    });

    it("keeps imessage enabled if already explicitly enabled (non-destructive)", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { entries: { imessage: { enabled: true } } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
    });

    it("allows imessage auto-configure when bluebubbles is explicitly disabled", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { entries: { bluebubbles: { enabled: false } } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBe(false);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("iMessage configured, enabled automatically.");
    });

    it("allows imessage auto-configure when bluebubbles is in deny list", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { deny: ["bluebubbles"] },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBeUndefined();
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
    });

    it("auto-enables imessage when only imessage is configured", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { imessage: { cliPath: "/usr/local/bin/imsg" } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("iMessage configured, enabled automatically.");
    });
  });
});
