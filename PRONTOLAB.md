# Pronto-Lab OpenClaw Fork - Multi-Agent Features

> **Pronto-Lab Fork** of [OpenClaw](https://github.com/openclaw/openclaw)
>
> Custom features for 7 agents coordinating via Discord.

## Overview

This fork adds multi-agent coordination features for the Pronto-Lab team. Seven AI agents communicate with each other through Discord DMs and coordinate work across shared tasks.

---

## Implemented Features

### 1. DM Retry (Discord DM Auto-Retry) ✅

**Purpose:** When Agent A sends a DM to Agent B and gets no response within the timeout period, the system automatically retries the message.

**Configuration:**

```json5
{
  channels: {
    discord: {
      dm: {
        retry: {
          enabled: true,
          timeoutMs: 300000, // 5 minutes
          maxAttempts: 3,
          backoffMs: 60000, // 1 minute between retries
          notifyOnFailure: true,
        },
      },
    },
  },
}
```

**Files:**
| File | Purpose |
|------|---------|
| `src/discord/dm-retry/tracker.ts` | Persistence layer for tracked DMs |
| `src/discord/dm-retry/utils.ts` | Config resolution helpers |
| `src/discord/dm-retry/scheduler.ts` | 60-second interval retry processor |
| `src/discord/dm-retry/index.ts` | Module exports |
| `src/config/types.discord.ts` | `DmRetryConfig` type definition |

**How it works:**

1. When an agent sends a DM, it's tracked in `dm-retry-tracking.json`
2. Every 60 seconds, the scheduler checks for timed-out pending DMs
3. Timed-out DMs are resent with a `[Retry N]` prefix
4. After max attempts, the DM is marked as failed

---

### 2. Task Continuation ✅

**Purpose:** Resume agents with pending work when the gateway restarts.

**Files:**
| File | Purpose |
|------|---------|
| `src/infra/task-continuation.ts` | Parse CURRENT_TASK.md and send resume messages |

**How it works:**

1. On gateway startup, scans each agent's workspace for `CURRENT_TASK.md`
2. Parses the `## Current` section for pending tasks
3. Sends a resume message to each agent with pending work
4. Includes task details, context, next steps, and progress

**CURRENT_TASK.md Format:**

```markdown
# Current Task

## Current

**Task:** Implement feature X
**Thread ID:** 12345
**Context:** User requested new button
**Next:** Add CSS styling
**Progress:**

- [x] Create component
- [ ] Add tests

---
```

---

### 3. Automatic Task Tracking ✅

**Purpose:** Automatically update `CURRENT_TASK.md` when an agent starts or finishes processing a message.

**Files:**
| File | Purpose |
|------|---------|
| `src/infra/task-tracker.ts` | Lifecycle event subscriber |
| `src/auto-reply/reply/agent-runner-execution.ts` | Integration: `registerTaskContext()` call |
| `src/commands/agent.ts` | Integration: `registerTaskContext()` call |
| `src/gateway/server-startup.ts` | Start task tracker on gateway startup |

**How it works:**

1. When agent processing starts, `registerTaskContext()` is called with the message body
2. On `lifecycle:start` event, writes task to `CURRENT_TASK.md`
3. On `lifecycle:end` or `lifecycle:error`, clears the task
4. If gateway crashes mid-task, `CURRENT_TASK.md` remains → Task Continuation picks it up on restart

---

### 4. Gateway Restart Notification ✅

**Purpose:** When an agent requests a gateway restart (e.g., "재시작해줘"), notify that agent after the restart completes so it can inform the user.

**Files:**
| File | Purpose |
|------|---------|
| `src/infra/restart-sentinel.ts` | Sentinel file with `requestingAgentId` field |
| `src/agents/tools/gateway-tool.ts` | Stores requesting agent ID when restart requested |
| `src/gateway/server-restart-sentinel.ts` | Post-restart notification logic |

**How it works:**

1. User tells agent: "Gateway 재시작해줘"
2. Agent calls `gateway({ action: "restart" })`
3. `requestingAgentId` is stored in `restart-sentinel.json`
4. Gateway restarts (SIGUSR1)
5. New gateway reads sentinel, sends message to requesting agent
6. Agent notifies user via Discord channel

**Flow:**

```
User → 루다: "재시작해줘"
     → 루다 calls gateway({ action: "restart" })
     → restart-sentinel.json { requestingAgentId: "main" }
     → Gateway restarts
     → notifyRequestingAgent("main")
     → 루다: "Gateway 재시작 완료됐어..."
     → 루다 → User (via 🌙-루다-dm channel)
```

---

### 5. Skill System (Phase 1) ✅

**Purpose:** Define domain-specific workflows and behaviors that can be injected into agent/subagent prompts.

**Files:**
| File | Purpose |
|------|---------|
| `~/.openclaw/skills/delegate/SKILL.md` | Category→model mapping + workflow skills |
| `~/.openclaw/SKILL-GOVERNANCE.md` | Skill creation governance and KPIs |

**Implemented Workflow Skills:**

| Skill                | Agent     | Purpose                           |
| -------------------- | --------- | --------------------------------- |
| `dev-tdd`            | 이든 💻   | TDD workflow (RED-GREEN-REFACTOR) |
| `git-commit`         | 이든/세움 | Conventional Commits convention   |
| `infra-troubleshoot` | 세움 🔧   | Incident response workflow        |

**How it works:**

1. Skills are defined in `<Workflow_Context>` blocks with English instructions
2. Each skill has: 적용 시점, 프롬프트 예시, 성공 지표
3. Skills are injected into subagent prompts via `sessions_spawn`
4. Governance document tracks KPIs and skill lifecycle

**Future Proposals:**

- Skill Groups + Lazy Loading (reduce context bloat)
- Per-agent default skill groups
- Task-aware skill selection

See:

- Proposal: `/Users/server/openclaw-future/PROPOSAL-skill-groups-impl.md`
- Governance: `~/.openclaw/SKILL-GOVERNANCE.md`

---

## Agent Configuration

| Agent ID         | Name        | Emoji | Role             |
| ---------------- | ----------- | ----- | ---------------- |
| `main` (default) | 루다 (Luda) | 🌙    | Main coordinator |
| `eden`           | 이든        | 💻    | Developer        |
| `seum`           | 세움        | 🔧    | Builder          |
| `yunseul`        | 윤슬        | ✨    | Creative         |
| `miri`           | 미리        | 📊    | Analyst          |
| `onsae`          | 온새        | 🌿    | Nature           |
| `ieum`           | 이음        | 🔗    | Connector        |

---

## Commands

### Build and Link

```bash
cd /Users/server/prontolab-openclaw
pnpm build && npm link
```

### Restart Gateway

```bash
pkill -9 -f "openclaw.*gateway"
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

### Watch Logs

```bash
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log
```

### Check Gateway Status

```bash
pgrep -f "openclaw.*gateway"
```

### Send Message to Agent

```bash
openclaw agent --agent main --message "안녕하세요"
```

### Test Restart Notification

```bash
openclaw agent --agent main --message "gateway tool로 재시작해줘"
```

---

## Git Information

| Item         | Value                                            |
| ------------ | ------------------------------------------------ |
| **Upstream** | https://github.com/openclaw/openclaw             |
| **Fork**     | https://github.com/Pronto-Lab/prontolab-openclaw |
| **Branch**   | `main`                                           |

### Recent Commits

```
2b2ce64cd feat(gateway): notify requesting agent after restart completes
ac42c3970 feat(infra): add automatic task tracking for CURRENT_TASK.md
e03205cf0 feat(discord): add DM retry and task continuation for multi-agent
```

---

## Key Files Reference

| Purpose                | File                                     |
| ---------------------- | ---------------------------------------- |
| Restart sentinel types | `src/infra/restart-sentinel.ts`          |
| Gateway restart wake   | `src/gateway/server-restart-sentinel.ts` |
| Gateway tool           | `src/agents/tools/gateway-tool.ts`       |
| Session key utils      | `src/routing/session-key.js`             |
| Task tracker           | `src/infra/task-tracker.ts`              |
| Task continuation      | `src/infra/task-continuation.ts`         |
| DM retry scheduler     | `src/discord/dm-retry/scheduler.ts`      |
| DM retry tracker       | `src/discord/dm-retry/tracker.ts`        |
| Gateway startup        | `src/gateway/server-startup.ts`          |

---

## Testing

Run all tests:

```bash
pnpm test
```

Run specific test file:

```bash
pnpm test src/discord/dm-retry/tracker.test.ts
pnpm test src/infra/task-tracker.test.ts
pnpm test src/infra/task-continuation.test.ts
pnpm test src/gateway/server-restart-sentinel.test.ts
```

---

## Upstream Sync

```bash
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

---

## Development Setup

```bash
cd /Users/server/prontolab-openclaw
pnpm install
pnpm build
npm link  # Use this build instead of global npm install
```

---

## Contributing Back to Upstream

If a feature is generally useful, consider submitting a PR to upstream:

1. Create clean feature branch from `main`
2. Implement with minimal changes
3. Add tests and docs
4. Submit PR to `openclaw/openclaw`

---

## Notes

- Korean language is used in agent messages (Korean team/users)
- `commands.restart: true` must be set in `~/.openclaw/openclaw.json` for restart command
- All features are designed to work with the existing OpenClaw infrastructure

---

_Last updated: 2026-02-03_
