import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./docker.js", () => ({
  execDockerRaw: vi.fn(),
}));

import type { SandboxContext } from "./types.js";
import { execDockerRaw } from "./docker.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { createSandboxTestContext } from "./test-fixtures.js";

const mockedExecDockerRaw = vi.mocked(execDockerRaw);
const DOCKER_SCRIPT_INDEX = 5;
const DOCKER_FIRST_SCRIPT_ARG_INDEX = 7;

function getDockerScript(args: string[]): string {
  return String(args[DOCKER_SCRIPT_INDEX] ?? "");
}

function getDockerArg(args: string[], position: number): string {
  return String(args[DOCKER_FIRST_SCRIPT_ARG_INDEX + position - 1] ?? "");
}

function getDockerPathArg(args: string[]): string {
  return getDockerArg(args, 1);
}

function getScriptsFromCalls(): string[] {
  return mockedExecDockerRaw.mock.calls.map(([args]) => getDockerScript(args));
}

function findCallByScriptFragment(fragment: string) {
  return mockedExecDockerRaw.mock.calls.find(([args]) => getDockerScript(args).includes(fragment));
}

function createSandbox(overrides?: Partial<SandboxContext>): SandboxContext {
  return createSandboxTestContext({
    overrides: {
      containerName: "moltbot-sbx-test",
      ...overrides,
    },
    dockerOverrides: {
      image: "moltbot-sandbox:bookworm-slim",
      containerPrefix: "moltbot-sbx-",
    },
  });
}

describe("sandbox fs bridge shell compatibility", () => {
  beforeEach(() => {
    mockedExecDockerRaw.mockReset();
    mockedExecDockerRaw.mockImplementation(async (args) => {
      const script = args[5] ?? "";
      if (script.includes('stat -c "%F|%s|%Y"')) {
        return {
          stdout: Buffer.from("regular file|1|2"),
          stderr: Buffer.alloc(0),
          code: 0,
        };
      }
      if (script.includes('cat -- "$1"')) {
        return {
          stdout: Buffer.from("content"),
          stderr: Buffer.alloc(0),
          code: 0,
        };
      }
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      };
    });
  });

  it("uses POSIX-safe shell prologue in all bridge commands", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.readFile({ filePath: "a.txt" });
    await bridge.writeFile({ filePath: "b.txt", data: "hello" });
    await bridge.mkdirp({ filePath: "nested" });
    await bridge.remove({ filePath: "b.txt" });
    await bridge.rename({ from: "a.txt", to: "c.txt" });
    await bridge.stat({ filePath: "c.txt" });

    expect(mockedExecDockerRaw).toHaveBeenCalled();

    const scripts = getScriptsFromCalls();
    const executables = mockedExecDockerRaw.mock.calls.map(([args]) => args[3] ?? "");

    expect(executables.every((shell) => shell === "sh")).toBe(true);
    expect(scripts.every((script) => /set -eu[;\n]/.test(script))).toBe(true);
    expect(scripts.some((script) => script.includes("pipefail"))).toBe(false);
  });

  it("resolveCanonicalContainerPath script is valid POSIX sh (no do; token)", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.readFile({ filePath: "a.txt" });

    const scripts = getScriptsFromCalls();
    const canonicalScript = scripts.find((script) => script.includes("allow_final"));
    expect(canonicalScript).toBeDefined();
    // "; " joining can create "do; cmd", which is invalid in POSIX sh.
    expect(canonicalScript).not.toMatch(/\bdo;/);
    // Keep command on the next line after "do" for POSIX-sh safety.
    expect(canonicalScript).toMatch(/\bdo\n\s*parent=/);
  });

  it("reads inbound media-style filenames with triple-dash ids", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });
    const inboundPath = "media/inbound/file_1095---f00a04a2-99a0-4d98-99b0-dfe61c5a4198.ogg";

    await bridge.readFile({ filePath: inboundPath });

    const readCall = findCallByScriptFragment('cat -- "$1"');
    expect(readCall).toBeDefined();
    const readPath = readCall ? getDockerPathArg(readCall[0]) : "";
    expect(readPath).toContain("file_1095---");
  });

  it("resolves dash-leading basenames into absolute container paths", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.readFile({ filePath: "--leading.txt" });

    const readCall = findCallByScriptFragment('cat -- "$1"');
    expect(readCall).toBeDefined();
    const readPath = readCall ? getDockerPathArg(readCall[0]) : "";
    expect(readPath).toBe("/workspace/--leading.txt");
  });

  it("resolves bind-mounted absolute container paths for reads", async () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/workspace-two:/workspace-two:ro"],
      },
    });
    const bridge = createSandboxFsBridge({ sandbox });

    await bridge.readFile({ filePath: "/workspace-two/README.md" });

    const args = mockedExecDockerRaw.mock.calls.at(-1)?.[0] ?? [];
    expect(args).toEqual(
      expect.arrayContaining(["moltbot-sbx-test", "sh", "-c", 'set -eu; cat -- "$1"']),
    );
    expect(getDockerPathArg(args)).toBe("/workspace-two/README.md");
  });

  it("blocks writes into read-only bind mounts", async () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/workspace-two:/workspace-two:ro"],
      },
    });
    const bridge = createSandboxFsBridge({ sandbox });

    await expect(
      bridge.writeFile({ filePath: "/workspace-two/new.txt", data: "hello" }),
    ).rejects.toThrow(/read-only/);
    expect(mockedExecDockerRaw).not.toHaveBeenCalled();
  });
});
