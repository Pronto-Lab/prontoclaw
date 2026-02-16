# Multi-Agent Coordination System

## Overview

This document describes the multi-agent coordination enhancements to the prontolab-openclaw task system. These changes improve reliability, observability, and agent-to-agent communication while preserving the existing Discord integration and task tools.

## Architecture

### Existing Infrastructure (Preserved)

- **Task Tools** (11 tools): task_start, task_update, task_complete, task_status, task_list, task_cancel, task_approve, task_block, task_resume, task_backlog_add, task_pick_backlog
- **Task Continuation Runner**: Periodic checker for idle tasks, blocked task unblocking, zombie detection
- **Agent Events**: emitAgentEvent/onAgentEvent pub/sub system
- **Task Lock**: File-based exclusive locks for task mutations
- **Agent Scope**: Agent ID resolution, workspace directories
- **Discord Integration**: Agent-bound account routing via resolveAgentBoundAccountId
- **Task Monitor API**: WebSocket server for real-time task state observation

### Phase 1: Race Condition Fixes

Six race conditions identified and fixed in task-continuation-runner.ts:

1. **Fix #1 - Continuation check lock (checkAgentForContinuation)**
   - Problem: Multiple concurrent continuation checks for the same agent could send duplicate prompts
   - Solution: Added per-agent lock acquisition before continuation check

2. **Fix #2+3 - Unblock TOCTOU (checkBlockedTasksForUnblock)**
   - Problem: Task state could change between read and write
   - Solution: Already fixed in Session 1 - lock + re-read pattern verified correct

3. **Fix #4 - Zombie detection gap (checkZombieTasksForAbandonment)**
   - Problem: Task could become active between initial check and abandonment
   - Solution: Lock + re-read already present; added freshness re-check of lastActivity

4. **Fix #5 - agentStates Map guard (runContinuationCheck)**
   - Problem: Map operations not atomic with async task operations
   - Solution: Guard agentStates access with try/catch boundaries

5. **Fix #6 - Cooldown slot reservation (checkBlockedTasksForResume)**
   - Problem: Multiple resume reminders could be sent before cooldown recorded
   - Solution: Set cooldown timestamp before sending, not after

### Phase 2: Event Bus + Broadcast

#### Event Bus (src/infra/events/)

- **bus.ts**: Typed event bus with subscribe/emit/unsubscribe
- **schemas.ts**: Zod schemas for all event types (task.started, task.updated, task.completed, etc.)
- **event-log.ts**: NDJSON file sink for event persistence

#### Instrumentation

- All task tools emit events after writeTask() calls
- task-continuation-runner emits coordination events (continuation.sent, unblock.requested, zombie.abandoned)
- agent-events.ts routes through new bus (backward-compatible)

#### Broadcast Mode

- sessions-send-tool.ts gains broadcast capability
- Sends message to all agents matching filter via parallel agentCommand calls

### Phase 3: Team Coordination State

#### Team State (src/infra/team-state.ts)

- Persistent team coordination state (replaces in-memory agentStates Map)
- Tracks: agent roles, current tasks, health status, last heartbeat
- Atomic read-modify-write via atomic-storage.ts

#### Atomic Storage (src/infra/atomic-storage.ts)

- File-based atomic read-modify-write helper
- Uses temp file + rename for crash safety
- Lock integration for concurrent access

#### Behavioral Changes

- Zombie tasks transition to "interrupted" instead of "abandoned"
- Lead agent notified when member agent task is interrupted
- Team state persisted to disk (survives process restart)

## Upstream PR Ports

### Tier 1 (CI pass, additive)

| PR     | Feature                                    | Impact     |
| ------ | ------------------------------------------ | ---------- |
| #7516  | From:/To: identity headers in A2A messages | +36 lines  |
| #7530  | Agent description field in config          | +102 lines |
| #9678  | Cross-agent memory allowlist               | +345 lines |
| #11814 | Subagent announce dedupe                   | +295 lines |
| #12075 | Browser session isolation                  | +139 lines |

### Tier 2 (lint fix needed)

| PR    | Feature                           | Impact      |
| ----- | --------------------------------- | ----------- |
| #6835 | Per-agent Discord webhook routing | +276 lines  |
| #6837 | Broadcast routing multi-agent     | +448 lines  |
| #7461 | Agent-to-agent loop prevention    | +1012 lines |

## Configuration

All configuration is via openclaw.json under agents.defaults.taskContinuation:

```json
{
  "agents": {
    "defaults": {
      "taskContinuation": {
        "enabled": true,
        "checkInterval": "2m",
        "idleThreshold": "3m",
        "zombieTaskTtl": "24h",
        "channel": "discord"
      }
    }
  }
}
```

## Phase 4: Upstream PR Ports (Wave 1)

### PR #8507 — Preserve accountId in A2A

- Adds `baseDelivery.lastAccountId` as second fallback in `agent-delivery.ts`
- Ensures correct account routing in multi-hop relay chains

### PR #6080 — historyIncludeBots

- New config: `channels.discord.historyIncludeBots: true`
- When enabled, bot messages are recorded to guild history before being dropped
- Gives multi-agent setups visibility into sibling agent output

### PR #12075 — Session-Aware Browser Isolation

- Replaces global `roleRefsByTarget` Map with per-session cache registry
- Prevents one agent's browser snapshot refs from leaking to another
- Adds `clearSessionRoleRefs(sessionKey)` for cleanup on session end

### TaskOutcome Type

- New discriminated union: `completed | cancelled | error | interrupted`
- Serialized as `## Outcome` section in task markdown files
- Set automatically on task_complete, task_cancel, and zombie interruption

### Plan Event Types

- Added `PLAN_SUBMITTED`, `PLAN_APPROVED`, `PLAN_REJECTED` to EVENT_TYPES

## Phase 5: Upstream PR Ports (Wave 2)

### PR #11644 — Sibling Bot Bypass

- `sibling-bots.ts`: Registry of sibling agent bot IDs
- Auto-registered on Discord login via `registerSiblingBot()`
- Sibling messages bypass the standard bot-drop filter in preflight

### EventBus → Discord Pipe

- `discord-sink.ts`: Subscribes to EventBus wildcard, batches events, sends as color-coded Discord embeds
- Configurable: webhook URL, event filter, batch window (5s default), max batch size (10)
- Rate limit aware with retry-after handling

### Session Tool Gate

- `session-tool-gate.ts`: Per-session tool permission gating
- Primitives: gate, approve, revoke, query
- Enables least-privilege execution for worker agents during plan approval flows

## Phase 6: Upstream PR Ports (Wave 3)

### PR #7461 — Agent-to-Agent Loop Prevention

- `loop-guard.ts`: Three-layer loop defense
  1. Self-message filter (applicationId match)
  2. Sliding-window rate limiter per A2A pair (10 msgs/60s default)
  3. A2A depth cap (5 hops default)

### Team State → Discord Dashboard

- `team-dashboard.ts`: Periodic embed posted/edited to Discord webhook
- Shows agent status (🟢/🟡/🔴), current task, last activity, failure reasons
- Configurable refresh interval (30s default)

### Plan Approval Flow

- `plan-approval.ts`: File-based plan storage and lifecycle
- Worker submits plan → Lead approves/rejects → Worker proceeds or adjusts
- Plans persisted as JSON in `.openclaw/plans/`

## File Map

| File                                             | Purpose                                             |
| ------------------------------------------------ | --------------------------------------------------- |
| src/infra/task-continuation-runner.ts            | Main coordination loop with race fixes              |
| src/infra/events/bus.ts                          | Typed event bus (subscribe/emit/reset)              |
| src/infra/events/schemas.ts                      | 19 event type definitions                           |
| src/infra/events/event-log.ts                    | NDJSON event sink                                   |
| src/infra/events/discord-sink.ts                 | EventBus → Discord webhook pipe                     |
| src/infra/team-state.ts                          | Persistent team coordination state                  |
| src/infra/team-dashboard.ts                      | Team state → Discord embed dashboard                |
| src/infra/atomic-storage.ts                      | Atomic RMW file helper                              |
| src/infra/plan-approval.ts                       | Plan submission/approval/rejection                  |
| src/agents/tools/task-tool.ts                    | Task tools with event emission + TaskOutcome        |
| src/agents/tools/sessions-send-tool.ts           | A2A messaging with broadcast                        |
| src/agents/session-tool-gate.ts                  | Per-session tool permission gating                  |
| src/infra/outbound/agent-delivery.ts             | A2A delivery with accountId preservation            |
| src/discord/monitor/sibling-bots.ts              | Sibling bot registry                                |
| src/discord/monitor/message-handler.preflight.ts | Bot filter with sibling bypass + historyIncludeBots |
| src/discord/monitor/provider.ts                  | Auto-register sibling bots on login                 |
| src/discord/loop-guard.ts                        | A2A loop detection + rate limiting                  |
| src/browser/pw-session.ts                        | Session-scoped browser role ref caches              |
| src/config/types.discord.ts                      | historyIncludeBots config type                      |
| src/config/zod-schema.providers-core.ts          | historyIncludeBots schema validation                |
| src/infra/agent-events.ts                        | Legacy event bridge                                 |
| src/infra/task-lock.ts                           | File-based task locks                               |

## Testing

Run all task-related tests:

```bash
pnpm vitest run --config vitest.unit.config.ts \
  src/agents/tools/task-tool.test.ts \
  src/infra/task-tracker.test.ts \
  src/infra/task-continuation.test.ts \
  src/infra/task-continuation-runner.test.ts \
  src/infra/task-continuation-runner.unblock.test.ts \
  src/infra/task-lock.test.ts \
  src/plugins/core-hooks/task-enforcer.test.ts
```

Run new infrastructure tests:

```bash
pnpm vitest run --config vitest.unit.config.ts \
  src/infra/events/bus.test.ts \
  src/infra/events/event-log.test.ts \
  src/infra/events/discord-sink.test.ts \
  src/infra/team-state.test.ts \
  src/infra/team-dashboard.test.ts \
  src/infra/atomic-storage.test.ts \
  src/infra/plan-approval.test.ts \
  src/agents/session-tool-gate.test.ts \
  src/discord/monitor/sibling-bots.test.ts \
  src/discord/loop-guard.test.ts
```

Run ALL coordination tests (full suite):

```bash
pnpm vitest run --config vitest.unit.config.ts \
  src/agents/tools/task-tool.test.ts \
  src/infra/task-continuation.test.ts \
  src/infra/task-continuation-runner.test.ts \
  src/infra/task-continuation-runner.unblock.test.ts \
  src/infra/task-lock.test.ts \
  src/plugins/core-hooks/task-enforcer.test.ts \
  src/infra/task-tracker.test.ts \
  src/infra/events/bus.test.ts \
  src/infra/events/event-log.test.ts \
  src/infra/events/discord-sink.test.ts \
  src/infra/atomic-storage.test.ts \
  src/infra/team-state.test.ts \
  src/infra/team-dashboard.test.ts \
  src/infra/plan-approval.test.ts \
  src/agents/session-tool-gate.test.ts \
  src/agents/subagent-announce.format.test.ts \
  src/infra/outbound/deliver.test.ts \
  src/discord/monitor/message-handler.process.test.ts \
  src/discord/monitor/sibling-bots.test.ts \
  src/discord/loop-guard.test.ts
```
