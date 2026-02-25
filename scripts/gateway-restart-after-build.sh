#!/usr/bin/env bash
# Restarts gateway after build (stale hash chunks cause MODULE_NOT_FOUND)
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="ai.openclaw.gateway"
if launchctl list "$LABEL" &>/dev/null; then
  echo "[gw-restart] Restarting via launchd..."
  launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null
else
  GW_PID=$(pgrep -f openclaw-gateway 2>/dev/null || true)
  if [ -n "$GW_PID" ]; then
    kill "$GW_PID" 2>/dev/null || true; sleep 2
    cd "$ROOT_DIR"
    nohup node dist/index.js gateway --port "${OPENCLAW_GATEWAY_PORT:-18789}" >> ~/.openclaw/logs/gateway.log 2>> ~/.openclaw/logs/gateway.err.log &
  fi
fi
