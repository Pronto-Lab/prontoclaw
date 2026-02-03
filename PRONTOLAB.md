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

1. **Tracking Layer** (`src/discord/dm-tracker.ts`)
   - Store outbound DM metadata (messageId, targetAgent, timestamp)
   - Track response received status
   - Cleanup on response or timeout

2. **Retry Logic** (`src/discord/dm-retry.ts`)
   - Periodic check for timed-out messages
   - Resend logic with backoff
   - Failure notification

3. **Integration Points**
   - Hook into Discord message send flow
   - Hook into message receive flow (to mark as responded)
   - Gateway startup/shutdown (persist tracking state)

#### Files to Modify

| File | Change |
|------|--------|
| `src/discord/index.ts` | Add retry config parsing |
| `src/discord/dm-tracker.ts` | New - tracking logic |
| `src/discord/dm-retry.ts` | New - retry logic |
| `src/discord/send.ts` | Hook outbound DMs |
| `src/discord/receive.ts` | Hook inbound responses |
| `src/config/schema.ts` | Add retry config schema |

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
