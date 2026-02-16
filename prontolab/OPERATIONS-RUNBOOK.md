# ProntoLab Operations Runbook

> This document mirrors operational guidance maintained in `../PRONTOLAB.md` so ProntoLab-specific docs stay centralized under `prontolab/`.

## Scope

- Upstream sync workflow for `prontolab-openclaw`
- Version-skew prevention checklist
- Validation gate before finalizing sync

## Upstream Sync (Intent-Preserving, Anti-Skew)

### 1) Prepare sync branch

```bash
git fetch upstream --tags
git checkout sync-upstream-v2026.2.15
```

### 2) Merge upstream tag

```bash
git merge --no-ff v2026.2.15
```

### 3) Conflict policy

- Preserve ProntoLab intent first on runtime-critical areas:
  - `src/gateway/*`
  - `src/discord/monitor/*`
  - `src/infra/task-*`
  - `src/agents/tools/*`
- Integrate upstream behavior only when it does not change ProntoLab semantics.
- Do not mix test/helper/runtime files across `HEAD` and `MERGE_HEAD` within the same cluster.

### 4) Version-skew audit

```bash
for f in   src/test-utils/channel-plugins.ts   src/infra/outbound/message-action-runner.ts   src/infra/outbound/targets.ts   src/discord/send.ts   src/auto-reply/reply/get-reply-run.ts   src/agents/subagent-announce-queue.ts
do
  cur=$(git hash-object "$f")
  h=$(git rev-parse "HEAD:$f" 2>/dev/null || true)
  m=$(git rev-parse "MERGE_HEAD:$f" 2>/dev/null || true)
  [ "$cur" = "$h" ] && ah=true || ah=false
  [ "$cur" = "$m" ] && am=true || am=false
  echo "$f,AT_HEAD=$ah,AT_MERGE_HEAD=$am"
done
```

Interpretation:
- `AT_HEAD=true` means current file equals pre-merge side.
- `AT_MERGE_HEAD=true` means current file equals upstream side.
- A failing cluster should be aligned to one side instead of partial mixing.

### 5) Validation gate (required)

```bash
pnpm build
pnpm test:fast
```

If either command fails, do not finalize the sync.

## Source of truth

- Primary operational tracker: `../PRONTOLAB.md`
- ProntoLab design/docs index: `./README.md`
