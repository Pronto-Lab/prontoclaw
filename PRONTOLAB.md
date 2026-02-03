# Pronto-Lab OpenClaw Fork

This is Pronto-Lab's fork of [OpenClaw](https://github.com/openclaw/openclaw).

## Fork Purpose

Custom features for Pronto-Lab's multi-agent AI team (7 agents coordinating via Discord).

## Upstream Sync

```bash
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

---

## Custom Features

### 1. DM Retry (Agent-to-Agent Communication)

**Status:** Planned

**Problem:**
When Agent A sends a DM to Agent B via Discord, if B doesn't respond (gateway disconnection, crash, or timeout), the message is lost with no retry mechanism.

**Current Flow:**
```
Agent A → Discord DM → Agent B
                ↓
         (B doesn't respond)
                ↓
         Message lost, no notification
```

**Proposed Solution:**
```
Agent A → Discord DM → Agent B
                ↓
         (N minutes, no response)
                ↓
         Auto-retry OR notify sender
```

#### Requirements

| Requirement | Description |
|-------------|-------------|
| Response tracking | Track outbound DMs and expected responses |
| Timeout detection | Configurable timeout (default: 5 min) |
| Retry mechanism | Auto-resend after timeout (configurable attempts) |
| Fallback notification | Alert sender if all retries fail |
| Configuration | Per-agent or global settings |

#### Proposed Config

```json5
{
  channels: {
    discord: {
      dm: {
        retry: {
          enabled: true,
          timeoutMs: 300000,      // 5 minutes
          maxAttempts: 3,
          backoffMs: 60000,       // 1 minute between retries
          notifyOnFailure: true,  // Notify sender after all retries fail
        }
      }
    }
  }
}
```

#### Implementation Approach

**Architecture Decision: Separate Tracking File (Option B)**

Rationale:
- Session store is per-agent, but DM tracking is cross-agent
- Separate file allows clean separation of concerns
- Easier to debug and migrate

**Tracking File Location:** `~/.openclaw/dm-retry-tracking.json`

---

#### Detailed Implementation Plan

##### Phase 1: Config Schema (PR-ready)

**Files to modify:**

| File | Change |
|------|--------|
| `src/config/types.discord.ts` | Add `DmRetryConfig` type to `DiscordDmConfig` |
| `src/config/zod-schema.core.ts` | Add `DmRetryConfigSchema` Zod validator |
| `src/config/zod-schema.providers-core.ts` | Add `dmRetry` to `DiscordDmSchema` |
| `src/config/schema.ts` | Add UI labels for `channels.discord.dm.retry.*` |

**New Type:**
```typescript
// src/config/types.discord.ts
export interface DmRetryConfig {
  enabled?: boolean;
  timeoutMs?: number;      // default: 300000 (5 min)
  maxAttempts?: number;    // default: 3
  backoffMs?: number;      // default: 60000 (1 min)
  notifyOnFailure?: boolean; // default: true
}
```

---

##### Phase 2: Tracking Layer

**New file: `src/discord/dm-retry/tracker.ts`**

```typescript
interface TrackedDm {
  id: string;                    // UUID
  messageId: string;             // Discord message ID
  channelId: string;             // DM channel ID
  senderAgentId: string;         // Agent that sent the DM
  targetAgentId: string;         // Agent that should respond
  originalText: string;          // Message content (for retry)
  sentAt: number;                // Timestamp
  attempts: number;              // Retry count
  status: 'pending' | 'responded' | 'failed';
}

interface DmRetryStore {
  version: number;
  tracked: Record<string, TrackedDm>;
}
```

**Functions:**
- `loadDmRetryStore(): DmRetryStore`
- `saveDmRetryStore(store: DmRetryStore): void`
- `trackOutboundDm(dm: TrackedDm): void`
- `markDmResponded(channelId: string, fromAgentId: string): void`
- `getTimedOutDms(timeoutMs: number): TrackedDm[]`
- `incrementRetryAttempt(id: string): TrackedDm`
- `markDmFailed(id: string): void`

---

##### Phase 3: Integration Hooks

**Outbound Hook: `src/discord/send.outbound.ts`**

Location: After successful `sendMessageDiscord()` return

```typescript
// After line ~89 (after recordChannelActivity)
if (isAgentToAgentDm && dmRetryConfig?.enabled) {
  trackOutboundDm({
    id: crypto.randomUUID(),
    messageId: result.messageId,
    channelId: result.channelId,
    senderAgentId: currentAgentId,
    targetAgentId: resolveAgentFromChannelId(result.channelId),
    originalText: text,
    sentAt: Date.now(),
    attempts: 1,
    status: 'pending',
  });
}
```

**Inbound Hook: `src/discord/monitor/message-handler.process.ts`**

Location: After `dispatchInboundMessage()` success

```typescript
// After successful inbound processing
if (isDirectMessage && dmRetryConfig?.enabled) {
  markDmResponded(channelId, senderAgentId);
}
```

---

##### Phase 4: Retry Timer

**New file: `src/discord/dm-retry/scheduler.ts`**

```typescript
let retryInterval: NodeJS.Timeout | null = null;

export function startDmRetryScheduler(cfg: DiscordConfig): void {
  if (!cfg.dm?.retry?.enabled) return;
  
  const checkIntervalMs = 60000; // Check every minute
  retryInterval = setInterval(() => {
    processPendingRetries(cfg);
  }, checkIntervalMs);
}

export function stopDmRetryScheduler(): void {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
  }
}

async function processPendingRetries(cfg: DiscordConfig): Promise<void> {
  const timedOut = getTimedOutDms(cfg.dm.retry.timeoutMs);
  
  for (const dm of timedOut) {
    if (dm.attempts >= cfg.dm.retry.maxAttempts) {
      markDmFailed(dm.id);
      if (cfg.dm.retry.notifyOnFailure) {
        await notifySenderOfFailure(dm);
      }
      continue;
    }
    
    // Retry
    incrementRetryAttempt(dm.id);
    await resendDm(dm);
  }
}
```

---

##### Phase 5: Gateway Integration

**File: `src/gateway/server-startup.ts`**

```typescript
// Add to startup sequence
import { startDmRetryScheduler } from '../discord/dm-retry/scheduler';

// In startup function
startDmRetryScheduler(cfg.channels.discord);
```

**File: `src/gateway/server.ts` (or shutdown handler)**

```typescript
// Add to shutdown sequence
import { stopDmRetryScheduler } from '../discord/dm-retry/scheduler';

// In shutdown handler
stopDmRetryScheduler();
```

---

##### Phase 6: Agent-to-Agent Detection

**Challenge:** How to know if a DM is agent-to-agent vs user-to-agent?

**Solution:** Check if recipient is a known agent bot ID

```typescript
// src/discord/dm-retry/utils.ts
export function isAgentToAgentDm(
  senderAgentId: string,
  recipientUserId: string,
  cfg: OpenClawConfig
): boolean {
  const agentBotIds = cfg.agents.list
    .filter(a => a.discord?.botId)
    .map(a => a.discord.botId);
  
  return agentBotIds.includes(recipientUserId);
}
```

---

#### File Summary

| File | Status | Purpose |
|------|--------|---------|
| `src/config/types.discord.ts` | Modify | Add DmRetryConfig type |
| `src/config/zod-schema.core.ts` | Modify | Add DmRetryConfigSchema |
| `src/config/zod-schema.providers-core.ts` | Modify | Wire into DiscordDmSchema |
| `src/config/schema.ts` | Modify | UI labels |
| `src/discord/dm-retry/tracker.ts` | **New** | Tracking state management |
| `src/discord/dm-retry/scheduler.ts` | **New** | Retry timer logic |
| `src/discord/dm-retry/utils.ts` | **New** | Helper functions |
| `src/discord/dm-retry/index.ts` | **New** | Module exports |
| `src/discord/send.outbound.ts` | Modify | Hook outbound DMs |
| `src/discord/monitor/message-handler.process.ts` | Modify | Hook inbound responses |
| `src/gateway/server-startup.ts` | Modify | Start scheduler |

---

#### Task Execution Order

```
[Wave 1 - Config] No dependencies
├── Task 1.1: Add DmRetryConfig type
├── Task 1.2: Add Zod schema
└── Task 1.3: Add UI labels

[Wave 2 - Core Logic] Depends on Wave 1
├── Task 2.1: Create tracker.ts
├── Task 2.2: Create utils.ts
└── Task 2.3: Create scheduler.ts

[Wave 3 - Integration] Depends on Wave 2
├── Task 3.1: Hook send.outbound.ts
├── Task 3.2: Hook message-handler.process.ts
└── Task 3.3: Hook gateway startup/shutdown

[Wave 4 - Testing] Depends on Wave 3
├── Task 4.1: Unit tests for tracker
├── Task 4.2: Unit tests for scheduler
└── Task 4.3: Integration test (2 agents)
```

#### Success Criteria

- [ ] Outbound DMs are tracked
- [ ] Timeout detection works
- [ ] Auto-retry sends after timeout
- [ ] Retry respects maxAttempts
- [ ] Sender notified on final failure
- [ ] Config is hot-reloadable
- [ ] No regression in existing Discord functionality
- [ ] Unit tests pass
- [ ] Integration test with 2+ agents

---

## Development Setup

```bash
cd /Users/server/prontolab-openclaw
pnpm install
pnpm build
npm link  # Use this build instead of global npm install
```

## Testing Local Build

```bash
# Use local build
npm link

# Restart gateway with local build
openclaw gateway restart

# Verify version
openclaw --version
```

## Contributing Back to Upstream

If a feature is generally useful, consider submitting a PR to upstream:

1. Create clean feature branch from `main`
2. Implement with minimal changes
3. Add tests and docs
4. Submit PR to `openclaw/openclaw`

---

*Last updated: 2026-02-03*
