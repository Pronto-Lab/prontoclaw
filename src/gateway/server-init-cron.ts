import type { OpenClawConfig } from "../config/config.js";
import type { CliDeps } from "../cli/deps.js";
import { buildGatewayCronService, type GatewayCronState } from "./server-cron.js";

export type GatewayCronInitState = {
  cronState: GatewayCronState;
  cron: GatewayCronState["cron"];
  cronStorePath: string;
};

export function initGatewayCron(opts: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  minimalTestGateway: boolean;
  logCron: { error: (msg: string) => void };
}): GatewayCronInitState {
  const cronState = buildGatewayCronService({
    cfg: opts.cfg,
    deps: opts.deps,
    broadcast: opts.broadcast,
  });
  const { cron, storePath: cronStorePath } = cronState;

  if (!opts.minimalTestGateway) {
    void cron.start().catch((err) => opts.logCron.error(`failed to start: ${String(err)}`));
  }

  return { cronState, cron, cronStorePath };
}
