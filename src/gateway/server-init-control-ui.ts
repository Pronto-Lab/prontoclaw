import path from "node:path";
import {
  ensureControlUiAssetsBuilt,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { RuntimeEnv } from "../runtime.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway");

/**
 * Resolve the Control UI root path.
 * Handles override paths, automatic asset building, and missing assets.
 */
export async function resolveControlUiState(opts: {
  controlUiRootOverride: string | undefined;
  controlUiEnabled: boolean;
  gatewayRuntime: RuntimeEnv;
  moduleUrl: string;
}): Promise<ControlUiRootState | undefined> {
  const { controlUiRootOverride, controlUiEnabled, gatewayRuntime, moduleUrl } = opts;

  if (controlUiRootOverride) {
    const resolvedOverride = resolveControlUiRootOverrideSync(controlUiRootOverride);
    const resolvedOverridePath = path.resolve(controlUiRootOverride);
    if (!resolvedOverride) {
      log.warn(`gateway: controlUi.root not found at ${resolvedOverridePath}`);
    }
    return resolvedOverride
      ? { kind: "resolved", path: resolvedOverride }
      : { kind: "invalid", path: resolvedOverridePath };
  }

  if (controlUiEnabled) {
    let resolvedRoot = resolveControlUiRootSync({
      moduleUrl,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
    if (!resolvedRoot) {
      const ensureResult = await ensureControlUiAssetsBuilt(gatewayRuntime);
      if (!ensureResult.ok && ensureResult.message) {
        log.warn(`gateway: ${ensureResult.message}`);
      }
      resolvedRoot = resolveControlUiRootSync({
        moduleUrl,
        argv1: process.argv[1],
        cwd: process.cwd(),
      });
    }
    return resolvedRoot
      ? { kind: "resolved", path: resolvedRoot }
      : { kind: "missing" };
  }

  return undefined;
}
