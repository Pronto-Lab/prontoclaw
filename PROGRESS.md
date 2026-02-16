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
