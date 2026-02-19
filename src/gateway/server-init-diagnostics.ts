import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { startDiagnosticHeartbeat } from "../logging/diagnostic.js";
import { setGatewaySigusr1RestartPolicy, setPreRestartDeferralCheck } from "../infra/restart.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import type { Config } from "../config/config.js";

/**
 * Initialize diagnostic heartbeat and restart policy.
 * Returns whether diagnostics are enabled (needed for cleanup on close).
 */
export function initDiagnostics(cfg: Config): { diagnosticsEnabled: boolean } {
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }
  setGatewaySigusr1RestartPolicy({ allowExternal: cfg.commands?.restart === true });
  setPreRestartDeferralCheck(
    () => getTotalQueueSize() + getTotalPendingReplies() + getActiveEmbeddedRunCount(),
  );
  return { diagnosticsEnabled };
}
