---
summary: "Collaboration event roles, projections, and conversation UI contract"
read_when:
  - You are changing task-monitor event APIs
  - You are building Task Hub conversation views
  - You need clear separation between raw logs and collaboration turns
title: "Collaboration Event Model"
---

# Collaboration event model

Last updated: 2026-02-17

## Why this exists

Collaboration data has two different audiences:

- System operators need full raw lifecycle logs.
- Humans in `Conversations` need readable turn-level exchanges.

This model separates those concerns so UI semantics stay stable.

## Role taxonomy

`eventRole` is the primary stream partition:

- `conversation.main`: main-agent to main-agent collaboration.
- `delegation.subagent`: main-agent to subagent delegation and subagent chains.
- `orchestration.task`: task lifecycle and orchestration state events.
- `system.observability`: health, monitor, and non-collaboration system signals.

## Raw events vs projections

Raw event types remain append-only (`a2a.send`, `a2a.response`, `a2a.complete`, `task.*`, etc).

UI should not consume raw logs directly unless it is an observability surface.
Use projections with explicit filters:

- `GET /api/events?...` for raw filtered logs.
- `GET /api/work-sessions?...` for grouped session/thread projections.

Both endpoints support:

- `role=<eventRole>` (csv or repeated)
- `type=<eventType>` (csv or repeated)

## Conversations contract (Task Hub)

Default `Conversations` behavior:

- `role=conversation.main`
- `type=a2a.response`

Meaning:

- The main conversation timeline is response-turn only.
- Lifecycle markers (`a2a.send`, `a2a.complete`) are hidden in normal mode.
- Each main-main turn should still produce exactly one `a2a.response` outcome event.
  If the target agent cannot produce a normal reply (timeout/error/not found), emit a blocked outcome in
  `a2a.response` instead of leaving the thread without a response turn.

Debug mode may opt into:

- `type=a2a.send,a2a.response,a2a.complete`

This keeps day-to-day collaboration readable while preserving diagnostic depth.

## Recommended handoff content for main-main turns

When emitting `a2a.response` for main-agent collaboration, include a goal-oriented outcome payload in message text.
Recommended sections:

1. `goal`: what this turn attempted.
2. `outcome`: success/partial/blocked + concise result.
3. `evidence`: proof links (files/tests/api responses).
4. `next_action`: what receiver should do next.

This is a content contract for reliable collaboration quality; lifecycle events are not a replacement for handoff payloads.

When success output is unavailable, response payload should include:

1. `outcome=blocked`
2. failure reason (`timeout` / `error` / `not_found`)
3. concrete next action or retry hint
