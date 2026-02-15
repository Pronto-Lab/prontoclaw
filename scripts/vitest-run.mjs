import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const REQUIRED_NODE_OPTIONS_FLAGS = ["--experimental-sqlite"];
const WARNING_SUPPRESSION_FLAGS = [
  "--disable-warning=ExperimentalWarning",
  "--disable-warning=DEP0040",
  "--disable-warning=DEP0060",
  "--disable-warning=MaxListenersExceededWarning",
];

const nodeOptions = process.env.NODE_OPTIONS ?? "";
const nextNodeOptions = [...WARNING_SUPPRESSION_FLAGS, ...REQUIRED_NODE_OPTIONS_FLAGS].reduce(
  (acc, flag) => (acc.includes(flag) ? acc : `${acc} ${flag}`.trim()),
  nodeOptions,
);

const child = spawn(pnpm, ["vitest", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nextNodeOptions },
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
