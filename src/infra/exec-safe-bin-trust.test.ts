import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTrustedSafeBinDirs,
  getTrustedSafeBinDirs,
  isTrustedSafeBinPath,
  listWritableExplicitTrustedSafeBinDirs,
} from "./exec-safe-bin-trust.js";

describe("exec safe bin trust", () => {
  it("builds trusted dirs from defaults and injected PATH", () => {
    const dirs = buildTrustedSafeBinDirs({
      pathEnv: "/custom/bin:/alt/bin:/custom/bin",
      delimiter: ":",
      baseDirs: ["/usr/bin"],
    });

    expect(dirs.has(path.resolve("/usr/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/custom/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/alt/bin"))).toBe(true);
    expect(dirs.size).toBe(3);
  });

  it("memoizes trusted dirs per PATH snapshot", () => {
    const a = getTrustedSafeBinDirs({
      pathEnv: "/first/bin",
      delimiter: ":",
      refresh: true,
    });
    const b = getTrustedSafeBinDirs({
      pathEnv: "/first/bin",
      delimiter: ":",
    });
    const c = getTrustedSafeBinDirs({
      pathEnv: "/second/bin",
      delimiter: ":",
    });

    expect(a).toBe(b);
    expect(c).not.toBe(b);
  });

  it("validates resolved paths using injected trusted dirs", () => {
    const trusted = new Set([path.resolve("/usr/bin")]);
    expect(
      isTrustedSafeBinPath({
        resolvedPath: "/usr/bin/jq",
        trustedDirs: trusted,
      }),
    ).toBe(true);
    expect(
      isTrustedSafeBinPath({
        resolvedPath: "/tmp/evil/jq",
        trustedDirs: trusted,
      }),
    ).toBe(false);
  });

  it("uses startup PATH snapshot when pathEnv is omitted", () => {
    const originalPath = process.env.PATH;
    const injected = `/tmp/openclaw-path-injected-${Date.now()}`;
    const initial = getTrustedSafeBinDirs({ refresh: true });
    try {
      process.env.PATH = `${injected}${path.delimiter}${originalPath ?? ""}`;
      const refreshed = getTrustedSafeBinDirs({ refresh: true });
      expect(refreshed.has(path.resolve(injected))).toBe(false);
      expect([...refreshed].toSorted()).toEqual([...initial].toSorted());
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("flags explicitly trusted dirs that are group/world writable", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-safe-bin-trust-"));
    try {
      await fs.chmod(dir, 0o777);
      const hits = listWritableExplicitTrustedSafeBinDirs([dir]);
      expect(hits).toEqual([
        {
          dir: path.resolve(dir),
          groupWritable: true,
          worldWritable: true,
        },
      ]);
    } finally {
      await fs.chmod(dir, 0o755).catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
