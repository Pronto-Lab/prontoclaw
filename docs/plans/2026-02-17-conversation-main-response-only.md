# Conversation Main Response-Only Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make collaboration conversations consume only `conversation.main` response turns by default, while keeping raw lifecycle events for debug and observability.

**Architecture:** Extend Task Monitor API with explicit `type` filtering so projections can request only target event types. Update Task Hub Conversations to consume `a2a.response` by default and expose a debug toggle to include `a2a.send` and `a2a.complete`. Document the event model contract so UI and backend semantics stay aligned.

**Tech Stack:** TypeScript, Bun/Node server script (`task-monitor-server.ts`), Next.js app (`task-hub`), Vitest.

---

### Task 1: Add failing tests for event-type filtering in work-session aggregation

**Files:**

- Modify: `src/task-monitor/task-monitor-work-sessions.test.ts`
- Modify: `scripts/task-monitor-server.ts` (after failing test)

**Step 1: Write the failing test**

Add a test that builds one work session with `a2a.send`, `a2a.response`, `a2a.complete`, then calls `buildWorkSessionsFromEvents(..., { eventTypeFilters: ["a2a.response"] })` and expects only response events to remain.

**Step 2: Run test to verify it fails**

Run: `pnpm test:fast -- src/task-monitor/task-monitor-work-sessions.test.ts`
Expected: FAIL due to missing `eventTypeFilters` support.

**Step 3: Write minimal implementation**

In `scripts/task-monitor-server.ts`, add `eventTypeFilters` to `BuildWorkSessionsOptions` and filter events in the aggregation loop.

**Step 4: Run test to verify it passes**

Run: `pnpm test:fast -- src/task-monitor/task-monitor-work-sessions.test.ts`
Expected: PASS.

### Task 2: Add failing tests for API-level `type` query filtering

**Files:**

- Modify: `src/task-monitor/task-monitor-work-sessions.test.ts`
- Modify: `scripts/task-monitor-server.ts` (after failing test)

**Step 1: Write the failing test**

Add test coverage that malformed/empty type filters are ignored and valid filters are honored by aggregation behavior.

**Step 2: Run test to verify it fails**

Run: `pnpm test:fast -- src/task-monitor/task-monitor-work-sessions.test.ts`
Expected: FAIL before parser/filter helper exists.

**Step 3: Write minimal implementation**

Add helpers to normalize event-type filters and wire them into:

- `GET /api/events`
- `GET /api/work-sessions`
- `GET /api/work-sessions/:id`

Also include filter echo fields in JSON responses for observability.

**Step 4: Run tests to verify pass**

Run: `pnpm test:fast -- src/task-monitor/task-monitor-work-sessions.test.ts src/task-monitor/task-monitor-events-classification.test.ts`
Expected: PASS.

### Task 3: Update Task Hub Conversations to response-only default with debug lifecycle toggle

**Files:**

- Modify: `/Users/server/Projects/task-hub/src/app/conversations/page.tsx`

**Step 1: Write behavior assertions (manual verification checklist)**

Define manual acceptance checks:

- default request uses `role=conversation.main` + `type=a2a.response`
- debug toggle ON requests `type=a2a.send,a2a.response,a2a.complete`
- default timeline contains only response bubbles
- debug mode shows lifecycle markers

**Step 2: Implement minimal UI/network changes**

Add `showDebugLifecycle` state and adjust fetch query params accordingly for both work-session primary fetch and events fallback fetch.

**Step 3: Verify behavior**

Run:

- `npm run lint` (task-hub)
- manual API check through Task Hub proxy endpoints.

Expected: lint passes, API requests return expected filtered data.

### Task 4: Document event model contract

**Files:**

- Create: `docs/concepts/collaboration-event-model.md`

**Step 1: Write doc content**

Document:

- role taxonomy (`conversation.main`, `delegation.subagent`, etc.)
- raw event taxonomy vs conversation turn projection
- conversation UI contract (default response-only, debug lifecycle optional)
- recommended goal/outcome/evidence/next-action handoff payload guidance.

**Step 2: Validate markdown style quickly**

Run: `pnpm format:docs:check` (or targeted formatting check if needed).
Expected: doc passes style checks.

### Task 5: End-to-end verification

**Files:**

- Verify modified files only

**Step 1: Run focused tests**

Run:

- `pnpm test:fast -- src/task-monitor/task-monitor-work-sessions.test.ts src/task-monitor/task-monitor-events-classification.test.ts`

**Step 2: Validate Task Hub app static checks**

Run:

- `npm run lint` in `/Users/server/Projects/task-hub`

**Step 3: Runtime smoke checks**

With compose up, validate:

- `/api/proxy/work-sessions?role=conversation.main&type=a2a.response`
- `/api/proxy/events?role=conversation.main&type=a2a.response`

Expected: successful responses with response-only event data by default.
