# Discord Migration Design: Conversation Sink Abstraction

> **Status**: Draft
> **Date**: 2026-02-23
> **Author**: 병욱 + Sisyphus
> **Scope**: prontolab-openclaw (gateway) + task-hub (dashboard)

---

## 1. Problem

Current A2A → task-hub conversations pipeline has critical issues:

- **Maintenance burden**: MongoDB DM model, WebSocket sync, optimistic cache (`useDMData` cacheRef), SSE proxy — all need separate maintenance
- **Bugs**: Message loss on page navigation (fixed but symptomatic of fragile architecture), dedup race conditions
- **Duplication**: Discord already running with 11 bot accounts. Same communication capability exists in two places
- **Complexity**: A2A event → task-hub-sink HTTP POST → MongoDB → WebSocket → React UI — too many hops for simple message delivery

## 2. Goal

- **Primary**: Route all agent conversations through Discord. Remove task-hub conversations entirely.
- **Constraint**: Keep task-hub task management (tasks, todos, milestones, workspace, events) intact.
- **Architecture**: Abstract the event sink layer so future platforms (Slack, Telegram, webhook) can be added without code changes.

## 3. Design Principles

1. **Single source of truth**: Discord is the conversation layer. No parallel MongoDB conversation store.
2. **Sink abstraction**: Event bus subscribers are pluggable. Adding a new output = implement interface + config.
3. **LLM-powered routing**: Channel and thread selection uses a lightweight LLM call for semantic matching.
4. **Minimal disruption**: A2A internal mechanism stays unchanged. Only the output layer changes.

---

## 4. Architecture

### 4.1 Current State (As-Is)

```
EventBus (bus.ts)
  ├── event-log.ts        → NDJSON file (wildcard, all events)
  ├── discord-sink.ts     → Discord webhook (monitoring embeds, batched)
  ├── task-hub-sink.ts    → HTTP POST to task-hub /api/dm/incoming  ← REMOVE
  └── a2a-index.ts        → Conversation index (O(1) lookup)

task-hub
  ├── Conversations (DM, Topic, Team)  ← REMOVE
  └── Task Management (Tasks, Todos, Milestones, Workspace, Events)  ← KEEP
```

### 4.2 Target State (To-Be)

```
EventBus (bus.ts)
  ├── event-log.ts                    → NDJSON file (unchanged)
  ├── discord-sink.ts                 → Discord webhook monitoring (unchanged)
  ├── DiscordConversationSink  ← NEW  → A2A events → Discord channel threads
  └── a2a-index.ts                    → Conversation index (unchanged)

SinkRegistry
  └── Manages lifecycle of all ConversationSink implementations
      (start, stop, reload from config)

task-hub
  └── Task Management only (Tasks, Todos, Milestones, Workspace, Events)
```

### 4.3 Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│                   Gateway :18789                         │
│                                                         │
│  ┌──────────┐    ┌──────────────────────────────────┐   │
│  │ EventBus │───▶│         SinkRegistry              │   │
│  │ (bus.ts) │    │                                    │   │
│  │          │    │  ┌────────────────────────────┐    │   │
│  │ emit()   │    │  │ DiscordConversationSink    │    │   │
│  │          │    │  │                            │    │   │
│  │ A2A_SEND │    │  │  ┌──────────────────────┐  │    │   │
│  │ A2A_RESP │    │  │  │   ChannelRouter      │  │    │   │
│  │ TASK_*   │    │  │  │   (LLM-based)        │  │    │   │
│  └──────────┘    │  │  │                      │  │    │   │
│                  │  │  │  Input: message,      │  │    │   │
│                  │  │  │    agents, channels   │  │    │   │
│                  │  │  │  Output: channelId,   │  │    │   │
│                  │  │  │    threadName         │  │    │   │
│                  │  │  └──────────────────────┘  │    │   │
│                  │  │                            │    │   │
│                  │  │  ThreadMap (in-memory)     │    │   │
│                  │  │  conversationId → threadId │    │   │
│                  │  └────────────────────────────┘    │   │
│                  │                                    │   │
│                  │  ┌────────────────────────────┐    │   │
│                  │  │ [Future: SlackSink, etc.]  │    │   │
│                  │  └────────────────────────────┘    │   │
│                  └──────────────────────────────────┘   │
│                                                         │
│  Discord API (11 bot accounts, existing)                │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    Discord Guild                         │
│                                                         │
│  #task-hub-리팩토링     ← thread: "DM 시스템 제거 논의"  │
│  #인프라-운영           ← thread: "Gateway 메모리 이슈"  │
│  #디자인-검토           ← thread: "대시보드 UI 개선"     │
│  #일반                  ← fallback channel               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 5. ConversationSink Interface

```typescript
// src/infra/events/conversation-sink.ts

export interface ConversationSinkConfig {
  id: string;
  enabled: boolean;
  options: Record<string, unknown>;
}

export interface ConversationSink {
  readonly id: string;
  start(config: ConversationSinkConfig): () => void;
}
```

Each sink:

- Subscribes to the EventBus internally (via `subscribe()`)
- Filters events it cares about
- Returns a cleanup function (called on gateway shutdown / config reload)

---

## 6. SinkRegistry

```typescript
// src/infra/events/sink-registry.ts

export class SinkRegistry {
  private sinks = new Map<string, ConversationSink>();
  private active = new Map<string, () => void>();

  register(sink: ConversationSink): void {
    this.sinks.set(sink.id, sink);
  }

  startAll(configs: ConversationSinkConfig[]): void {
    for (const config of configs) {
      if (!config.enabled) continue;
      const sink = this.sinks.get(config.id);
      if (!sink) continue;
      const stop = sink.start(config);
      this.active.set(config.id, stop);
    }
  }

  stopAll(): void {
    for (const [id, stop] of this.active) {
      stop();
      this.active.delete(id);
    }
  }

  reload(configs: ConversationSinkConfig[]): void {
    this.stopAll();
    this.startAll(configs);
  }
}
```

---

## 7. DiscordConversationSink

### 7.1 Responsibilities

1. **Subscribe** to A2A events (`a2a.send`, `a2a.response`) on the EventBus
2. **Filter** to `conversation.main` role only (skip subagent chatter)
3. **Resolve thread**: lookup `conversationId` in ThreadMap
4. **Route new conversations**: call ChannelRouter (LLM) to pick channel + thread name
5. **Create Discord thread**: via `createThreadDiscord()` API
6. **Post message**: via `sendMessageDiscord()` with agent identity (name, emoji)
7. **Track thread**: store mapping in ThreadMap for subsequent messages

### 7.2 Event Flow

```
A2A Event (conversation.main)
    │
    ▼
eventRole === "conversation.main"?  ──NO──▶ skip
    │ YES
    ▼
threadMap.get(conversationId)
    │
    ├── HIT ──▶ sendMessageDiscord(threadId, formatted message)
    │
    └── MISS ──▶ ChannelRouter.route(context)
                    │
                    ▼
              LLM call (fast model, 1 time per new conversation)
              Input:  { message, fromAgent, toAgent, topicId, channels[] }
              Output: { channelId, threadName }
                    │
                    ▼
              createThreadDiscord(channelId, { name: threadName })
                    │
                    ▼
              threadMap.set(conversationId, { threadId, channelId, agents })
                    │
                    ▼
              sendMessageDiscord(threadId, formatted first message)
```

### 7.3 ThreadMap

```typescript
interface ThreadInfo {
  threadId: string;
  channelId: string;
  agents: [string, string];  // sorted agent pair
  createdAt: number;
}

// In-memory map. Lost on gateway restart (acceptable — new conversations get new threads).
// Old threads remain in Discord as archive.
private threadMap = new Map<string, ThreadInfo>();
```

### 7.4 Message Formatting

```
┌──────────────────────────────────────┐
│ 🌙 루다 → 💻 이든                    │
│                                      │
│ task-hub의 DM 시스템을 제거하고       │
│ Discord 스레드로 대체하는 방안을      │
│ 검토해줄 수 있어?                    │
└──────────────────────────────────────┘
```

Format: `{fromEmoji} {fromName} → {toEmoji} {toName}\n\n{message}`

Agent identity source: `openclaw.json → agents.list[].identity.{name, emoji}`

---

## 8. ChannelRouter (Sub-agent based)

### 8.1 Purpose

When a new A2A conversation starts (no existing thread in ThreadMap), ChannelRouter must decide:

1. Is there an **existing thread** in the guild that matches this conversation? → Reuse it
2. If not, which **channel** should the new thread be created in?
3. What should the **thread name** be?

This is a judgment task, not a simple lookup — a dedicated sub-agent handles it.

### 8.2 Why Sub-agent, Not Simple LLM Call

| Simple LLM Call                        | Sub-agent                                                           |
| -------------------------------------- | ------------------------------------------------------------------- |
| Sees only channel list + first message | Sees channels, **existing threads**, recent messages                |
| Can only create new threads            | Can **reuse existing threads** that match the topic                 |
| Single prompt, rigid JSON output       | Multi-step reasoning: search → evaluate → decide                    |
| No tool access                         | Has Discord read tools (list channels, list threads, read messages) |

### 8.3 Design

```typescript
// src/infra/events/sinks/channel-router.ts
  message: string;         // first message content (truncated to 500 chars)
  fromAgent: string;       // agent ID
  toAgent: string;         // agent ID
  fromAgentName: string;   // display name
  toAgentName: string;     // display name
  topicId?: string;        // if available from A2A event
  conversationId: string;  // A2A conversation ID
}
export interface RouteResult {
  channelId: string;
  threadId?: string;       // if reusing existing thread (undefined = create new)
  threadName: string;      // max 100 chars (Discord limit), used when creating new
  reasoning?: string;      // why this channel/thread was chosen (for debugging)
}
export class ChannelRouter {
  private guildId: string;
  private defaultChannelId: string;
  private model: string;
  private accountId: string;
  async route(context: RouteContext): Promise<RouteResult>;
  private buildSubagentPrompt(context: RouteContext): string;
  private parseResult(output: string): RouteResult;
}
```

### 8.4 Sub-agent Flow

```
New A2A conversation (MISS in ThreadMap)
    │
    ▼
ChannelRouter.route(context)
    │
    ▼
Spawn lightweight sub-agent session
    │
    ├── Tool: listGuildChannels(guildId)
    │     → [{id, name, topic, parentName}, ...]
    │
    ├── Tool: listActiveThreads(guildId)
    │     → [{id, name, channelId, messageCount, lastMessageAt}, ...]
    │
    ├── (Optional) Tool: readRecentMessages(threadId, limit=3)
    │     → Check if existing thread's topic matches
    │
    └── Decide:
          ├── Existing thread matches? → Return { threadId, channelId }
          └── No match? → Pick channel + create threadName
                            → Return { channelId, threadName }
    │
    ▼
RouteResult → DiscordConversationSink
    │
    ├── threadId exists → reuse (sendMessageDiscord to threadId)
    └── threadId absent → createThreadDiscord(channelId, threadName)
```

### 8.5 Sub-agent Prompt

```
You are a Discord thread router for an AI agent team.
Your job: find the best place for an agent-to-agent conversation.

[New Conversation]
From: {fromAgent} ({fromAgentName})
To: {toAgent} ({toAgentName})
Topic ID: {topicId || "N/A"}
First message:
---
{message (500 chars max)}
---

[Instructions]
1. Use listGuildChannels to see all available channels
2. Use listActiveThreads to see existing threads
3. Check if any existing thread's topic closely matches this conversation
   - If YES: return that thread (reuse)
   - If NO: pick the most appropriate channel and create a new thread name
4. Thread name rules:
   - Korean, concise, max 50 chars
   - Describe the discussion topic (not the agents)
   - Examples: "Gateway 메모리 누수 분석", "task-hub DM 시스템 마이그레이션"

Return JSON:
{ "channelId": "...", "threadId": "...or null", "threadName": "...", "reasoning": "..." }
```

### 8.6 Sub-agent Configuration

```typescript
// Sub-agent does NOT use the full agent session system.
// It's a minimal, stateless LLM call with tool access.
//
// Tools available to the sub-agent:
//   - listGuildChannels(guildId) → channel list
//   - listActiveThreads(guildId) → active thread list
//   - readRecentMessages(threadId, limit) → recent messages in a thread
//
// Model: fast + cheap (sonnet-class or codex-mini)
// Max turns: 3 (list channels → list threads → decide)
// Timeout: 15 seconds total
// No persistent state — each routing call is independent
```

### 8.7 Thread Reuse Logic

The sub-agent can reuse an existing thread when:

- Thread name semantically matches the new conversation topic
- Thread is in a relevant channel
- Thread was active recently (not months old)
- Thread is not archived

This means conversations about the same topic naturally converge to the same thread,
even across different `conversationId`s. The ThreadMap in DiscordConversationSink
is updated to point to the reused thread.

```
Example:
  Eden starts A2A about "task-hub 리팩토링" → sub-agent finds existing thread
  "task-hub DM 시스템 마이그레이션" in #task-hub-리팩토링 → reuses it

  Ruda starts A2A about "새로운 모니터링 대시보드" → no matching thread
  → sub-agent picks #인프라-운영 → creates "모니터링 대시보드 설계 논의"
```

### 8.8 Fallback Behavior

| Scenario                      | Behavior                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Sub-agent timeout (>15s)      | Use `defaultChannelId`, thread name = `"{fromName} ↔ {toName} · {timestamp}"` |
| Sub-agent error / crash       | Same fallback                                                                 |
| No matching channel or thread | Sub-agent returns `defaultChannelId` + new thread name                        |
| Invalid output from sub-agent | Parse error → use fallback                                                    |
| Discord API error in tools    | Sub-agent sees error, falls back to default channel                           |

---

## 9. Configuration

### 9.1 Gateway Config (openclaw.json)

```jsonc
{
  "gateway": {
    "conversationSinks": [
      {
        "id": "discord-conversation",
        "enabled": true,
        "options": {
          "guildId": "1465235700235632672",
          "defaultChannelId": "1465243584348426345",
          "routerModel": "anthropic/claude-sonnet-4-5",
          "routerAccountId": "ruda",
          "messageAccountId": "ruda",
          "archivePolicy": "never",
          "eventFilter": ["a2a.send", "a2a.response"],
        },
      },
    ],
  },
}
```

| Option             | Type                                     | Description                                           |
| ------------------ | ---------------------------------------- | ----------------------------------------------------- |
| `guildId`          | string                                   | Discord guild for channel listing and thread creation |
| `defaultChannelId` | string                                   | Fallback channel when LLM routing fails               |
| `routerModel`      | string                                   | LLM model for channel/thread selection                |
| `routerAccountId`  | string                                   | Discord bot account for channel list API calls        |
| `messageAccountId` | string                                   | Discord bot account for sending messages              |
| `archivePolicy`    | `"never"` \| `"24h"` \| `"3d"` \| `"7d"` | Thread auto-archive duration                          |
| `eventFilter`      | string[]                                 | Which event types to forward                          |

### 9.2 Config Type Definition

```typescript
// Addition to src/config/types.ts (or new file)

export interface ConversationSinkEntry {
  id: string;
  enabled: boolean;
  options: Record<string, unknown>;
}

// In GatewayConfig:
export interface GatewayConfig {
  // ... existing fields ...
  conversationSinks?: ConversationSinkEntry[];
}
```

---

## 10. Task-Hub Changes

### 10.1 Files to Remove

**Pages & Layouts:**

- `src/app/conversations/page.tsx`
- `src/app/conversations/layout.tsx`

**Channel Components (all):**

- `src/components/Channel/` (entire directory)

**Conversation Components (all):**

- `src/components/Conversations/` (entire directory)

**API Routes:**

- `src/app/api/dm/route.ts`
- `src/app/api/dm/incoming/route.ts`
- `src/app/api/dm/[conversationId]/route.ts`
- `src/app/api/agent/send/route.ts`
- `src/app/api/team/send/route.ts`
- `src/app/api/conversations/summarize/route.ts`

**Hooks:**

- `src/hooks/useDMData.ts`
- `src/hooks/useConversationData.ts`
- `src/hooks/useGatewayWebSocket.ts`

**Models:**

- `src/models/DMConversation.ts`
- `src/models/ChatLog.ts`

**Lib:**

- `src/lib/conversations/` (entire directory)
- `src/lib/reporting/dm-reporter.ts`

### 10.2 Files to Modify

**AppNav** (`src/components/AppNav.tsx`):

- Remove "Conversations" navigation link

**Reporting** (`src/lib/reporting/index.ts`):

- Remove DMTaskReporter registration
- Task completion reports are now handled by DiscordConversationSink
  (or a separate task event in the sink that posts to Discord)

**Gateway lib** (`src/lib/gateway.ts`):

- Keep `sendToAgent()` — still used by task delegation (todos, milestones)
- Keep `delegateToAgent()` — still used by todo delegation
- Remove conversation-specific wrappers if any

**Hook exports** (`src/hooks/index.ts`):

- Remove conversation hook exports

### 10.3 Files to Keep (Unchanged)

- All task pages (`/tasks`, `/todos`, `/milestones`, `/workspace`, `/events`)
- All task components (`Tasks/`, `TodoItem`, `AddTodoForm`, `MilestoneModals`, etc.)
- All task API routes (`/api/tasks/*`, `/api/todos/*`, `/api/milestones/*`)
- MongoDB connection, auth, shared utilities
- `useTaskData.ts` hook
- Task types and models (`Todo`, `Milestone`)

---

## 11. Task Completion Reporting

Currently `DMTaskReporter` writes task reports to MongoDB `DMConversation`.
After migration, task reports should go to Discord.

### Option: Gateway-side reporting via EventBus

Task events (`task.completed`, `task.cancelled`, `task.blocked`) already flow through the EventBus.
The `DiscordConversationSink` can handle these:

```typescript
// Inside DiscordConversationSink event handler:
if (event.type === "task.completed" || event.type === "task.cancelled") {
  const channelId = config.defaultChannelId; // or task-specific channel
  const message = formatTaskReport(event);
  await sendMessageDiscord(channelId, message, opts);
}
```

This eliminates the need for task-hub-side reporting entirely.

---

## 12. Migration Steps

### Phase 1: Gateway — Sink Abstraction + DiscordConversationSink

1. Create `ConversationSink` interface + `SinkRegistry`
2. Create `DiscordConversationSink` with ThreadMap
3. Create `ChannelRouter` with LLM routing
4. Add `conversationSinks` config type
5. Wire `SinkRegistry` into `server-startup.ts` (replace `startTaskHubSink()`)
6. Adapt existing `discord-sink.ts` to `ConversationSink` interface (optional, for consistency)
7. Delete `task-hub-sink.ts`
8. Build, deploy, verify on mac-mini

### Phase 2: Task-Hub — Remove Conversations

1. Delete conversation pages, components, API routes, hooks, models
2. Update AppNav to remove Conversations link
3. Remove DMTaskReporter from reporting registry
4. Clean up unused imports and exports
5. Build, deploy, verify on mac-mini

### Phase 3: Verification

1. Trigger A2A conversation between two main agents
2. Verify: Discord thread created in correct channel with correct name
3. Verify: Subsequent messages in same conversation go to same thread
4. Verify: Task management in task-hub still works (tasks, todos, milestones)
5. Verify: Task delegation via `sendToAgent()` still works
6. Verify: Gateway restart doesn't break existing conversations (new threads for new conversations, old threads remain in Discord)

---

## 13. Existing APIs Used

### Discord (already available in fork)

| Function                                            | File                           | Usage                     |
| --------------------------------------------------- | ------------------------------ | ------------------------- |
| `createThreadDiscord(channelId, { name, content })` | `src/discord/send.messages.ts` | Create new thread         |
| `sendMessageDiscord(target, text, opts)`            | `src/discord/send.ts`          | Send message to thread    |
| `createDiscordClient(opts)`                         | `src/discord/client.ts`        | Get REST client           |
| `resolveDiscordRest(opts)`                          | `src/discord/send.shared.ts`   | Resolve REST from account |

### EventBus (already available)

| Function              | File                      | Usage                 |
| --------------------- | ------------------------- | --------------------- |
| `subscribe(type, fn)` | `src/infra/events/bus.ts` | Subscribe to events   |
| `subscribe("*", fn)`  | `src/infra/events/bus.ts` | Wildcard subscription |
| `emit(event)`         | `src/infra/events/bus.ts` | Emit events           |

### Agent Identity (from config)

```typescript
// openclaw.json → agents.list[]
{ id: "ruda", identity: { name: "루다", emoji: "🌙" } }
{ id: "eden", identity: { name: "이든", emoji: "💻" } }
// ... etc
```

---

## 14. Risk & Mitigation

| Risk                                          | Impact                                               | Mitigation                                                                                                          |
| --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| LLM routing picks wrong channel               | Low — conversation still visible, just wrong channel | Fallback to default channel. User can move thread manually. LLM accuracy improves with better channel descriptions. |
| Discord API rate limits                       | Medium — messages delayed                            | Batching (inherit pattern from discord-sink.ts). Rate limit aware retry.                                            |
| Gateway restart loses ThreadMap               | Low — only affects in-flight conversations           | New conversations get new threads. Old threads remain in Discord. Acceptable trade-off vs persistence complexity.   |
| `sendToAgent()` breaks after task-hub cleanup | High — task delegation breaks                        | Keep `sendToAgent()` and `delegateToAgent()` intact. Only remove conversation-specific code.                        |
| Agent conversation too long for Discord       | Low — Discord threads can be very long               | Message chunking already exists (`chunkDiscordTextWithMode`).                                                       |

---

## 15. Future Extensibility

Adding a new platform (e.g., Slack):

1. Implement `ConversationSink` interface (`SlackConversationSink`)
2. Add to `SinkRegistry.register()`
3. Add config entry to `conversationSinks[]`
4. No changes to EventBus, A2A, or other sinks

Adding new event types:

1. Add to `EVENT_TYPES` in `schemas.ts`
2. Add to sink's `eventFilter` in config
3. Sink handles formatting internally
