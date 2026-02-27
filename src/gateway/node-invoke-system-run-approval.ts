import {
  formatExecCommand,
  validateSystemRunCommandConsistency,
} from "../infra/system-run-command.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "./exec-approval-manager.js";
import type { GatewayClient } from "./server-methods/types.js";

type SystemRunParamsLike = {
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  env?: unknown;
  timeoutMs?: unknown;
  needsScreenRecording?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  approved?: unknown;
  approvalDecision?: unknown;
  runId?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeApprovalDecision(value: unknown): "allow-once" | "allow-always" | null {
  const s = normalizeString(value);
  return s === "allow-once" || s === "allow-always" ? s : null;
}

function clientHasApprovals(client: GatewayClient | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client?.connect?.scopes : [];
  return scopes.includes("operator.admin") || scopes.includes("operator.approvals");
}

function getCmdText(params: SystemRunParamsLike): string {
  const raw = normalizeString(params.rawCommand);
  if (raw) {
    return raw;
  }
  if (Array.isArray(params.command)) {
    const parts = params.command.map((v) => String(v));
    if (parts.length > 0) {
      return formatExecCommand(parts);
    }
  }
  return "";
}

function approvalMatchesRequest(params: SystemRunParamsLike, record: ExecApprovalRecord): boolean {
  if (record.request.host !== "node") {
    return false;
  }

  const cmdText = getCmdText(params);
  if (!cmdText || record.request.command !== cmdText) {
    return false;
  }

  const reqCwd = record.request.cwd ?? null;
  const runCwd = normalizeString(params.cwd) ?? null;
  if (reqCwd !== runCwd) {
    return false;
  }

  const reqAgentId = record.request.agentId ?? null;
  const runAgentId = normalizeString(params.agentId) ?? null;
  if (reqAgentId !== runAgentId) {
    return false;
  }

  const reqSessionKey = record.request.sessionKey ?? null;
  const runSessionKey = normalizeString(params.sessionKey) ?? null;
  if (reqSessionKey !== runSessionKey) {
    return false;
  }

  return true;
}

function pickSystemRunParams(raw: Record<string, unknown>): Record<string, unknown> {
  // Defensive allowlist: only forward fields that the node-host `system.run` handler understands.
  // This prevents future internal control fields from being smuggled through the gateway.
  const next: Record<string, unknown> = {};
  for (const key of [
    "command",
    "rawCommand",
    "cwd",
    "env",
    "timeoutMs",
    "needsScreenRecording",
    "agentId",
    "sessionKey",
    "runId",
  ]) {
    if (key in raw) {
      next[key] = raw[key];
    }
  }
  return next;
}

/**
 * Gate `system.run` approval flags (`approved`, `approvalDecision`) behind a real
 * `exec.approval.*` record. This prevents users with only `operator.write` from
 * bypassing node-host approvals by injecting control fields into `node.invoke`.
 */
export function sanitizeSystemRunParamsForForwarding(opts: {
  rawParams: unknown;
  client: GatewayClient | null;
  execApprovalManager?: ExecApprovalManager;
  nowMs?: number;
}):
  | { ok: true; params: unknown }
  | { ok: false; message: string; details?: Record<string, unknown> } {
  const obj = asRecord(opts.rawParams);
  if (!obj) {
    return { ok: true, params: opts.rawParams };
  }

  const p = obj as SystemRunParamsLike;
  const argv = Array.isArray(p.command) ? p.command.map((v) => String(v)) : [];
  const raw = normalizeString(p.rawCommand);
  if (raw) {
    if (!Array.isArray(p.command) || argv.length === 0) {
      return {
        ok: false,
        message: "rawCommand requires params.command",
        details: { code: "MISSING_COMMAND" },
      };
    }
    const validation = validateSystemRunCommandConsistency({ argv, rawCommand: raw });
    if (!validation.ok) {
      return {
        ok: false,
        message: validation.message,
        details: validation.details ?? { code: "RAW_COMMAND_MISMATCH" },
      };
    }
  }

  const approved = p.approved === true;
  const requestedDecision = normalizeApprovalDecision(p.approvalDecision);
  const wantsApprovalOverride = approved || requestedDecision !== null;

  // Always strip control fields from user input. If the override is allowed,
  // we re-add trusted fields based on the gateway approval record.
  const next: Record<string, unknown> = pickSystemRunParams(obj);

  if (!wantsApprovalOverride) {
    const cmdTextResolution = resolveSystemRunCommand({
      command: p.command,
      rawCommand: p.rawCommand,
    });
    if (!cmdTextResolution.ok) {
      return {
        ok: false,
        message: cmdTextResolution.message,
        details: cmdTextResolution.details,
      };
    }
    return { ok: true, params: next };
  }

  const runId = normalizeString(p.runId);
  if (!runId) {
    return systemRunApprovalGuardError({
      code: "MISSING_RUN_ID",
      message: "approval override requires params.runId",
    });
  }

  const manager = opts.execApprovalManager;
  if (!manager) {
    return systemRunApprovalGuardError({
      code: "APPROVALS_UNAVAILABLE",
      message: "exec approvals unavailable",
    });
  }

  const snapshot = manager.getSnapshot(runId);
  if (!snapshot) {
    return systemRunApprovalGuardError({
      code: "UNKNOWN_APPROVAL_ID",
      message: "unknown or expired approval id",
      details: { runId },
    });
  }

  const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
  if (nowMs > snapshot.expiresAtMs) {
    return systemRunApprovalGuardError({
      code: "APPROVAL_EXPIRED",
      message: "approval expired",
      details: { runId },
    });
  }

  // Prefer binding by device identity (stable across reconnects / per-call clients like callGateway()).
  // Fallback to connId only when device identity is not available.
  const snapshotDeviceId = snapshot.requestedByDeviceId ?? null;
  const clientDeviceId = opts.client?.connect?.device?.id ?? null;
  if (snapshotDeviceId) {
    if (snapshotDeviceId !== clientDeviceId) {
      return systemRunApprovalGuardError({
        code: "APPROVAL_DEVICE_MISMATCH",
        message: "approval id not valid for this device",
        details: { runId },
      });
    }
  } else if (
    snapshot.requestedByConnId &&
    snapshot.requestedByConnId !== (opts.client?.connId ?? null)
  ) {
    return systemRunApprovalGuardError({
      code: "APPROVAL_CLIENT_MISMATCH",
      message: "approval id not valid for this client",
      details: { runId },
    });
  }

  if (!approvalMatchesRequest(p, snapshot)) {
    return {
      ok: false,
      message: runtimeContext.message,
      details: runtimeContext.details,
    };
  }
  if (runtimeContext.planV2) {
    next.command = [...runtimeContext.planV2.argv];
    if (runtimeContext.rawCommand) {
      next.rawCommand = runtimeContext.rawCommand;
    } else {
      delete next.rawCommand;
    }
    if (runtimeContext.cwd) {
      next.cwd = runtimeContext.cwd;
    } else {
      delete next.cwd;
    }
    if (runtimeContext.agentId) {
      next.agentId = runtimeContext.agentId;
    } else {
      delete next.agentId;
    }
    if (runtimeContext.sessionKey) {
      next.sessionKey = runtimeContext.sessionKey;
    } else {
      delete next.sessionKey;
    }
  }

  const approvalMatch = evaluateSystemRunApprovalMatch({
    argv: runtimeContext.argv,
    request: snapshot.request,
    binding: {
      cwd: runtimeContext.cwd,
      agentId: runtimeContext.agentId,
      sessionKey: runtimeContext.sessionKey,
      env: p.env,
    },
  });
  if (!approvalMatch.ok) {
    return toSystemRunApprovalMismatchError({ runId, match: approvalMatch });
  }

  // Normal path: enforce the decision recorded by the gateway.
  if (snapshot.decision === "allow-once") {
    if (typeof manager.consumeAllowOnce !== "function" || !manager.consumeAllowOnce(runId)) {
      return systemRunApprovalRequired(runId);
    }
    next.approved = true;
    next.approvalDecision = "allow-once";
    return { ok: true, params: next };
  }

  if (snapshot.decision === "allow-always") {
    next.approved = true;
    next.approvalDecision = "allow-always";
    return { ok: true, params: next };
  }

  // If the approval request timed out (decision=null), allow askFallback-driven
  // "allow-once" ONLY for clients that are allowed to use exec approvals.
  const timedOut =
    snapshot.resolvedAtMs !== undefined &&
    snapshot.decision === undefined &&
    snapshot.resolvedBy === null;
  if (
    timedOut &&
    approved &&
    requestedDecision === "allow-once" &&
    clientHasApprovals(opts.client)
  ) {
    next.approved = true;
    next.approvalDecision = "allow-once";
    return { ok: true, params: next };
  }

  return systemRunApprovalRequired(runId);
}
