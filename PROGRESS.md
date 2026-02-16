# Progress

## 2026-02-16

- Reapplied intent-preserving upstream sync and anti-version-skew workflow to `PRONTOLAB.md` on `main`.
- Added `prontolab/OPERATIONS-RUNBOOK.md` to mirror operational guidance inside the `prontolab/` docs directory.
- Updated `prontolab/README.md` to include the operations runbook and clarified relation with `PRONTOLAB.md`.
- Updated root `README.md` docs section with direct links to ProntoLab operational documentation.
- Restored Telegram poll runtime wiring in src/plugins/runtime/index.ts (re-added sendPollTelegram import and telegram runtime mapping) and confirmed pnpm build:plugin-sdk:dts passes.
