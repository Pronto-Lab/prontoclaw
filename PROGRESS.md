# Progress

## 2026-02-16

- Reapplied intent-preserving upstream sync and anti-version-skew workflow to `PRONTOLAB.md` on `main`.
- Added `prontolab/OPERATIONS-RUNBOOK.md` to mirror operational guidance inside the `prontolab/` docs directory.
- Updated `prontolab/README.md` to include the operations runbook and clarified relation with `PRONTOLAB.md`.
- Updated root `README.md` docs section with direct links to ProntoLab operational documentation.
- Restored Telegram poll runtime wiring in src/plugins/runtime/index.ts (re-added sendPollTelegram import and telegram runtime mapping) and confirmed pnpm build:plugin-sdk:dts passes.
- 2026-02-16 19:27 KST: Added channels.discord.accounts.default as ruda fallback token copy in ~/.openclaw/openclaw.json, removed unsupported discord keys, restarted ai.openclaw.gateway, verified no new default-token-missing errors and build passed.
- 2026-02-16 19:35 KST: Added docs/prontolab deferred plan for dedicated Discord fallback bot split and corrected Discord thread session-key docs to match runtime (thread channel id key + parent-session metadata linkage).
- 2026-02-16 19:42 KST: Mirrored docs/ into docs/prontolab (preserving existing custom prontolab files), corrected Discord thread session-key docs in zh-CN mirror, and added ProntoLab-specific gateway health notes (18789 HTTP /health,/api/health 404; use WS health and Task Monitor 3847 API).
- 2026-02-16 19:47 KST: Relocated mirrored documentation from docs/prontolab/ into repo-root prontolab/ (preserved existing root prontolab custom docs), removed docs/prontolab, and verified key channel/gateway docs now exist under prontolab/.
- 2026-02-16 19:53 KST: Added prontolab/custom/ as a curated custom-docs collection (copied key custom docs + deferred fallback plan) while keeping original top-level prontolab files intact for link compatibility.
- 2026-02-16 19:56 KST: Updated prontolab/index.md to add a direct link to the custom docs collection at /prontolab/custom/README.
- Audited .openclaw and prontolab-openclaw against prontolab/custom docs, then updated prontolab/README.md status wording and refreshed drifted references in prontolab/custom/REFERENCES.md (subagent deny list, bootstrap symbol path, and snapshot timestamp).

## 2026-02-18

### A2A HEARTBEAT_OK Bug Fix

- **Root cause identified**: A2A sessions (`agent:ruda:a2a:{conversationId}`) were running with `promptMode="full"`, which injected the Heartbeat section ("reply HEARTBEAT_OK if no pending work") into the system prompt. On ping-pong turn 2+, agents interpreted the A2A reply as a heartbeat poll and responded with "No pending work. HEARTBEAT_OK".
- **Fix applied** (4 files):
  - `src/routing/session-key.ts`: Added `isA2ASessionKey` to re-exports
  - `src/agents/pi-embedded-runner/run/attempt.ts`: A2A sessions now use `promptMode="minimal"` (no Heartbeat section in system prompt)
  - `src/agents/pi-embedded-runner/compact.ts`: Same `promptMode="minimal"` for A2A sessions
  - `src/agents/workspace.ts`: A2A-specific bootstrap allowlist (AGENTS.md, TOOLS.md, IDENTITY.md only — excludes HEARTBEAT.md and BOOT.md)
- **E2E verified**: Two A2A conversations tested, ruda returned meaningful technical responses (zero HEARTBEAT_OK).

### A2A Ping-Pong Improvements

- **maxPingPongTurns raised to 30** (was 5, hard limit was 10):
  - `src/config/zod-schema.session.ts`: Validation max 10 → 30
  - `src/agents/tools/sessions-send-helpers.ts`: DEFAULT=30, MAX=30
  - `src/config/types.base.ts`: Updated JSDoc
- **Intent classifier fix** — collaboration patterns now checked BEFORE question patterns:
  - `src/agents/tools/a2a-intent-classifier.ts`: Reordered pattern checks, expanded collaboration patterns (논의, 토론, 설계하자, 같이, 함께, 의견, 피드백, 리뷰, 검토, 합의, 조율, 상의, brainstorm, collaborate, etc.), default intent changed from "question" to "collaboration"
- **REPLY_SKIP guideline strengthened**:
  - `src/agents/tools/sessions-send-helpers.ts`: Added rules: "If the other agent asked you questions, you MUST answer them", "If the other agent proposed something, share your opinion or build on it", "Only reply REPLY_SKIP when there is genuinely nothing left to discuss"
- **E2E verified**: Multi-turn ping-pong conversations now working — agents exchange meaningful replies, ask follow-up questions, and respond to each other's proposals.

### A2A Discord Mention/Cross-posting Fix

- **Root cause identified** — Two code paths caused agents to post to Discord during internal A2A collaboration:
  1. **Agent autonomous fallback**: When `sessions_send` timed out, agents self-decided to use the `message` tool to send Discord DMs directly (e.g., ruda: "sessions_send 타임아웃. Discord DM으로 직접 보내자.")
  2. **Announce path**: After A2A ping-pong completed, `shouldRunAnnounce()` allowed announce delivery to Discord channels when both parties were agents (the announce target was resolved from session delivery context)
- **Fix applied** (3 files):
  - `src/agents/tools/sessions-send-helpers.ts`:
    - Added explicit Discord/external channel prohibition to `buildAgentToAgentMessageContext()` ("NEVER use the message tool to send messages to Discord/Telegram/Slack for agent-to-agent communication", "If sessions_send times out, report the failure — do NOT fall back to external channels")
    - Added same prohibition to `buildAgentToAgentReplyContext()` and `buildAgentToAgentAnnounceContext()`
  - `src/agents/tools/a2a-intent-classifier.ts`:
    - Extended `shouldRunAnnounce()` to accept `requesterSessionKey` and `targetSessionKey` params
    - Added agent↔agent detection: if both requester and target match `agent:*:(main|a2a:|subagent:)` pattern, skip announce entirely
  - `src/agents/tools/sessions-send-tool.a2a.ts`:
    - Updated `shouldRunAnnounce()` calls to pass requester/target session keys
- **E2E verified**: After deployment, A2A conversations (ruda↔eden) produced zero new `message` tool calls to Discord. All `a2a.complete` events show `announced=False, announceSkipped=True`.
