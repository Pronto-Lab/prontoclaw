# Discord Native A2A: sessions_send를 Discord 스레드 통신으로 전환

> **Status**: Draft v2
> **Date**: 2026-02-26
> **Author**: 병욱
> **Scope**: prontolab-openclaw (gateway)
> **Based on**: OpenClaw 기존 Discord 메시지 파이프라인 활용

---

## 1. Problem

### 1.1 sessions_send 기반 A2A의 근본적 한계

현재 에이전트 간 통신(`sessions_send`)은 **별도 A2A 세션 레인**에서 동작하며, 이 세션은 의도적으로 에이전트의 핵심 컨텍스트를 제거한다.

```typescript
// workspace.ts:472-476 — A2A 세션에서 로드되는 파일
const A2A_BOOTSTRAP_ALLOWLIST = new Set([
  "AGENTS.md", // ✅
  "TOOLS.md", // ✅
  "IDENTITY.md", // ✅
  // MEMORY.md    ❌ 제외
  // SOUL.md      ❌ 제외
  // USER.md      ❌ 제외
]);
```

| 문제                    | 영향                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| **기억상실 대화**       | 에이전트가 A2A에서 MEMORY.md에 접근 못함 → 이전 결정, 교훈, 프로젝트 맥락 없이 대화 |
| **이전 협업 망각**      | 각 A2A 대화가 일회성 세션(`agent:eden:a2a:<uuid>`) → 어제 논의한 내용을 오늘 모름   |
| **성격/말투 소실**      | SOUL.md 제외 → 에이전트 성격이 A2A에서 사라짐                                       |
| **Discord가 거울일 뿐** | 대화는 내부 RPC로 끝나고, Discord에는 미러링만 됨                                   |
| **사람 개입 불가**      | Discord 스레드에 병욱이 글을 써도 에이전트가 무시                                   |
| **대화 기록 사장**      | A2A 세션 트랜스크립트가 디스크에 남지만, 다시 참조되지 않음                         |

### 1.2 핵심 질문

> sessions_send가 만드는 "기억 없는 별도 세션"에서 대화하는 것보다,
> **기존 OpenClaw Discord 파이프라인을 그대로 타서 풀 컨텍스트로 대화**하는 게 낫지 않나?

**답: 그렇다.** OpenClaw는 이미 Discord 메시지 → 에이전트 처리 → Discord 응답의 완전한 파이프라인을 갖추고 있다.

---

## 2. Goal

### 2.1 핵심 목표

1. **Discord 스레드가 에이전트 간 통신의 실제 채널**: sessions_send 대신 Discord 스레드에서 소통
2. **풀 컨텍스트 유지**: MEMORY.md, SOUL.md, CURRENT_TASK.md 포함한 완전한 에이전트 컨텍스트
3. **대화 연속성**: 같은 스레드 = 같은 세션, 이전 대화 히스토리 자동 보존
4. **메시지 전달 보장**: 응답 없으면 재시도, 최종 실패 시 에스컬레이션
5. **사람 개입 가능**: 병욱이 스레드에서 자연스럽게 에이전트와 소통

### 2.2 Non-Goal

- sessions_send 즉시 제거 (점진적 전환, 공존 기간 필요)
- Discord 외 채널 지원 (Slack, Telegram 등은 향후 SinkRegistry로 확장)

---

## 3. 핵심 설계: OpenClaw 기존 파이프라인 재활용

### 3.1 OpenClaw의 기존 Discord 파이프라인 (이미 있는 것)

```
Discord MESSAGE_CREATE
  │
  ▼
DiscordMessageListener              [listeners.ts]
  │
  ▼
Debouncer (같은 채널+같은 유저 그룹화) [message-handler.ts]
  │
  ▼
preflightDiscordMessage()            [message-handler.preflight.ts]
  │  - 자기자신/봇 필터
  │  - DM/Guild 분류
  │  - resolveAgentRoute() → agentId + sessionKey 결정
  │  - 멘션 검증
  │  - 길드/채널 allowlist
  │  - 스레드 부모 해석
  │
  ▼
processDiscordMessage()              [message-handler.process.ts]
  │  - 스레드 세션키 해석 (resolveThreadSessionKeys)
  │  - 인바운드 컨텍스트 조립
  │  - 세션 기록 (recordInboundSession)
  │  - dispatchInboundMessage() → LLM 호출
  │  - 응답 → deliverDiscordReply() → Discord API
  │
  ▼
Discord 스레드에 응답 메시지 도착
```

**핵심 발견**: 이 파이프라인은 **스레드를 이미 네이티브로 지원**한다.

- 스레드 메시지의 세션 키: `agent:{agentId}:discord:channel:{threadChannelId}`
- 스레드 ID가 peer ID로 사용되므로 **스레드별 세션 격리**가 자동으로 됨
- 같은 스레드의 메시지는 같은 세션에 쌓임 → **대화 히스토리 자동 보존**
- 메인 세션이 아닌 스레드별 세션이므로 **컨텍스트 오염 없음**

### 3.2 현재 이 파이프라인이 A2A에 쓰이지 않는 이유

`message-handler.preflight.ts`에서 **형제 봇(sibling bot) 메시지를 드랍**하기 때문:

```typescript
// message-handler.preflight.ts:101-142
// allowBots 설정이 꺼져 있으면 봇 메시지를 히스토리에만 기록하고 드랍
if (isBot && !allowBots) {
  // sibling bot이면 히스토리에 기록 (preflight 이전)
  // 하지만 에이전트 처리로는 넘기지 않음 → 드랍
  return null;
}
```

**즉, 형제 봇의 멘션을 "허용"하기만 하면 기존 파이프라인이 그대로 A2A에 쓸 수 있다.**

### 3.3 Target Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         Gateway :18789                           │
│                                                                  │
│  에이전트가 다른 에이전트에게 말하고 싶을 때:                       │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  1. Discord 스레드에 @멘션 메시지 작성                      │   │
│  │     (sendMessageDiscord → 기존 API)                        │   │
│  │     루다 봇 → #프로젝트 스레드에 "@이든 코드 리뷰 부탁"      │   │
│  └───────────────────────────────┬───────────────────────────┘   │
│                                  │                               │
│                                  ▼                               │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  2. 이든 봇이 MESSAGE_CREATE 수신 (기존 파이프라인)          │   │
│  │     → preflightDiscordMessage()                            │   │
│  │       → 형제 봇 멘션 허용 (NEW: allowSiblingMentions)       │   │
│  │       → resolveAgentRoute() → agentId: "eden"              │   │
│  │       → 스레드 세션키: agent:eden:discord:channel:{threadId}│   │
│  │     → processDiscordMessage()                              │   │
│  │       → 풀 컨텍스트 로드 (AGENTS + TOOLS + IDENTITY +      │   │
│  │         MEMORY + SOUL + CURRENT_TASK)  ← A2A와의 핵심 차이  │   │
│  │       → dispatchInboundMessage() → LLM 호출                │   │
│  │       → deliverDiscordReply() → 같은 스레드에 응답           │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  3. ResponseTracker (NEW)                                  │   │
│  │     - 멘션 전송 시 pending 등록                             │   │
│  │     - 응답 수신 시 responded 전환                           │   │
│  │     - 타임아웃 시 A2ARetryScheduler가 재멘션                │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 4. 기존 A2A 세션 vs Discord 스레드 세션 비교

| 항목                | A2A 세션 (sessions_send)          | Discord 스레드 세션 (신규)                                                 |
| ------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| **세션 키**         | `agent:eden:a2a:<uuid>` (일회성)  | `agent:eden:discord:channel:<threadId>` (스레드 수명)                      |
| **부트스트랩 파일** | AGENTS + TOOLS + IDENTITY (3개만) | **전체** (AGENTS + TOOLS + IDENTITY + MEMORY + SOUL + USER + CURRENT_TASK) |
| **대화 히스토리**   | 세션 내 핑퐁만 (200자 요약)       | **스레드 전체 대화가 세션에 누적**                                         |
| **이전 대화 기억**  | ❌ 새 conversationId = 새 세션    | ✅ 같은 스레드 = 같은 세션 재사용                                          |
| **세션 격리**       | ✅ (A2A 세션별 분리)              | ✅ (스레드별 분리, threadId = peer)                                        |
| **사람 개입**       | ❌ (별도 세션이라 불가)           | ✅ (같은 스레드에 글 쓰면 됨)                                              |
| **대화 기록**       | 세션 트랜스크립트 (참조 안 됨)    | **Discord 스레드 = 영구 가시 기록**                                        |
| **통신 속도**       | 빠름 (내부 RPC, ~1-3초)           | 느림 (Discord API 왕복, ~3-10초)                                           |
| **안정성**          | 높음 (내부 프로세스)              | Discord API 의존                                                           |
| **동기/비동기**     | 동기 (핑퐁 폴링)                  | **비동기** (메시지 보내고, 나중에 응답 옴)                                 |

---

## 5. 상세 설계

### 5.1 에이전트 → 에이전트 메시지 전송: `discord_send` 도구

에이전트가 다른 에이전트에게 메시지를 보낼 때 사용하는 새 MCP 도구.

```typescript
// src/agents/tools/discord-send-tool.ts

const DiscordSendToolSchema = Type.Object({
  targetAgentId: Type.String(), // 대상 에이전트 ID (필수)
  message: Type.String(), // 메시지 본문 (필수)
  threadId: Type.Optional(Type.String()), // 기존 스레드에 이어쓰기 (선택)
  channelId: Type.Optional(Type.String()), // 새 스레드를 만들 채널 (선택)
  threadName: Type.Optional(Type.String()), // 새 스레드 이름 (선택)
  topicId: Type.Optional(Type.String()), // ChannelRouter에 힌트 (선택)
  urgent: Type.Optional(Type.Boolean()), // 긴급 여부 → 재시도 주기 단축
});
```

**동작 흐름:**

```
discord_send(targetAgentId: "eden", message: "코드 리뷰 해줘")
  │
  ├── threadId 있음? → 기존 스레드에 메시지 전송
  │
  └── threadId 없음?
        │
        ├── ChannelRouter.route() → 적절한 채널/스레드 결정 (기존 LLM 라우터 재활용)
        │     → 기존 스레드 재사용 or 새 스레드 생성
        │
        └── sendMessageDiscord(target, "@이든\n\n코드 리뷰 해줘")
              │
              └── ResponseTracker.trackMention() → pending 등록
```

**sessions_send와의 차이:**

|           | sessions_send                             | discord_send                                    |
| --------- | ----------------------------------------- | ----------------------------------------------- |
| 실행 방식 | 동기: 보내고 → 응답 올 때까지 대기 → 핑퐁 | **비동기: 보내고 → 즉시 반환**                  |
| 결과 반환 | 상대방 응답 텍스트 반환                   | "메시지 전송 완료. 스레드 ID: ..." 반환         |
| 후속 대화 | 핑퐁 오케스트레이터가 자동 진행           | **상대방이 Discord 스레드에서 자연스럽게 응답** |

### 5.2 형제 봇 멘션 허용: preflight 수정

현재 형제 봇 메시지를 드랍하는 로직에 **스레드 내 멘션 허용** 옵션 추가.

```typescript
// message-handler.preflight.ts 수정

// 기존: 봇 메시지 무조건 드랍 (히스토리만 기록)
// 수정: 스레드 내 형제 봇 멘션이면 허용

if (isBot && !allowBots) {
  // NEW: 스레드 내 형제 봇이 우리 봇을 멘션했으면 허용
  if (
    threadCommunicationEnabled &&
    isSiblingBot(authorId) &&
    isInThread &&
    mentionsOurBot(message, botUserId)
  ) {
    // 드랍하지 않고 계속 진행 → processDiscordMessage로 전달
    // 세션키: agent:{ourAgentId}:discord:channel:{threadId}
  } else {
    // 기존 동작: 히스토리에만 기록하고 드랍
    return null;
  }
}
```

**변경 범위 최소화**: `message-handler.preflight.ts`의 봇 필터 분기에 조건 하나만 추가. 나머지 파이프라인(라우팅, 세션키 생성, 디스패치, 응답 전달)은 **전혀 수정하지 않음**.

### 5.3 스레드 세션의 부트스트랩 컨텍스트

A2A 세션과 달리 스레드 세션은 **풀 컨텍스트**를 로드해야 한다.

```typescript
// workspace.ts 수정

// 기존: A2A 세션이면 allowlist 필터
if (isA2ASessionKey(sessionKey)) {
  return files.filter((file) => A2A_BOOTSTRAP_ALLOWLIST.has(file.name));
}

// 수정: 스레드 세션은 풀 컨텍스트 (기존 코드 유지, A2A가 아니므로 필터 안 탐)
// 스레드 세션 키: agent:eden:discord:channel:123456
// → isA2ASessionKey()가 false 반환 → 필터 없이 전체 파일 로드 ✅
```

**이미 맞다!** 스레드 세션 키(`agent:eden:discord:channel:...`)는 `isA2ASessionKey()` 패턴(`agent:*:a2a:*`)에 매치되지 않으므로, **코드 수정 없이** 자동으로 풀 컨텍스트가 로드됨.

### 5.4 ResponseTracker — 응답 추적

```typescript
// src/discord/a2a-retry/tracker.ts

export type TrackedMentionStatus = "pending" | "responded" | "failed";

export interface TrackedMention {
  id: string; // UUID
  messageId: string; // Discord 메시지 ID
  threadId: string; // Discord 스레드 ID
  fromAgentId: string; // 발신 에이전트 (또는 "human")
  targetAgentId: string; // 멘션된 에이전트
  targetBotId: string; // 멘션된 봇의 Discord ID
  originalText: string; // 원본 메시지 (500자 truncated)
  status: TrackedMentionStatus;
  sentAt: number;
  attempts: number; // 0 = 첫 전송
  lastAttemptAt: number;
  respondedAt?: number;
}

// 저장소: ~/.openclaw/a2a-mention-tracking.json
// atomic write (tmp → rename) + 파일 퍼미션 0o600 (dm-retry와 동일 패턴)
```

**응답 감지**: `message-handler.preflight.ts`의 sibling bot 히스토리 기록 단계에서 수행.

```typescript
// message-handler.preflight.ts — 히스토리 기록 직전/직후

// 형제 봇이 스레드에 메시지를 썼으면 → 해당 스레드의 pending 전부 responded
if (isSiblingBot(authorId) && isInThread) {
  const responderAgentId = getAgentIdForBot(authorId);
  markMentionResponded(threadChannelId, responderAgentId);
}
```

### 5.5 A2ARetryScheduler — 재시도

```typescript
// src/discord/a2a-retry/scheduler.ts

// dm-retry/scheduler.ts와 동일 패턴

const CHECK_INTERVAL_MS = 60_000; // 60초 폴링
const DEFAULT_TIMEOUT_MS = 5 * 60_000; // 5분 무응답 판정
const DEFAULT_MAX_ATTEMPTS = 3;
const CLEANUP_MAX_AGE_MS = 24 * 3600_000;

async function processPendingRetries(): Promise<void> {
  await cleanupOldEntries(CLEANUP_MAX_AGE_MS);

  const timedOut = getTimedOutMentions(config.responseTimeoutMs);

  for (const mention of timedOut) {
    if (mention.attempts >= config.maxAttempts) {
      await markMentionFailed(mention.id);
      await sendEscalation(mention); // ⚠️ @병욱 확인 필요
      continue;
    }

    await incrementMentionAttempt(mention.id);
    await sendReminder(mention); // [리마인더 N/3] @이든 ...
  }
}
```

**리마인더 메시지**:

```
[리마인더 1/3] @이든 위 요청에 대해 확인 부탁해요.
원본: "코드 리뷰 해줘" (5분 전)
```

**에스컬레이션 메시지**:

```
⚠️ 응답 없음 (3회 시도, 15분 경과)
대상: @이든
요청: "코드 리뷰 해줘"
@병욱 확인 필요
```

### 5.6 사람 개입

병욱이 스레드에 메시지를 쓰면 **기존 파이프라인이 이미 처리**한다.

```
병욱 (Discord 유저)이 스레드에 "@이든 이건 이렇게 해" 작성
  │
  ▼
preflightDiscordMessage()
  → 봇 메시지가 아님 (사람) → 봇 필터 통과 ✅
  → resolveAgentRoute() → 스레드가 이든 봇의 채널에 있으면 agentId: "eden"
  → 멘션 체크 → @이든 멘션 있음 ✅
  │
  ▼
processDiscordMessage()
  → 세션키: agent:eden:discord:channel:{threadId}
  → 풀 컨텍스트 로드 (MEMORY, SOUL 포함)
  → 기존 스레드 세션 히스토리에 병욱 메시지 추가
  → LLM 호출 → 이든이 응답
  → Discord 스레드에 응답 전달
```

**코드 수정 불필요!** 사람 메시지는 기존 파이프라인으로 이미 처리됨. 단, 스레드의 부모 채널이 해당 에이전트의 `binding.peer`에 연결되어 있어야 `resolveAgentRoute()`가 올바른 에이전트를 선택한다.

---

## 6. 세션 격리와 컨텍스트 오염 방지

### 6.1 "메인 세션에 다 섞이는 문제"가 없는 이유

```
스레드별 세션 격리:

#프로젝트-백로그 > "인증 시스템 설계"
  └→ 세션: agent:eden:discord:channel:1111111 (이 스레드 전용)
     히스토리: [루다의 요청, 이든의 응답, 병욱의 개입, ...]

#인프라-운영 > "메모리 누수 분석"
  └→ 세션: agent:eden:discord:channel:2222222 (이 스레드 전용)
     히스토리: [세움의 요청, 이든의 분석, ...]

이든의 메인 세션: agent:eden:main (DM 전용)
  └→ 위 스레드 대화와 완전히 분리됨
```

OpenClaw는 스레드 ID를 peer ID로 사용하므로 `agent:eden:discord:channel:{threadId}` 형태의 **스레드별 고유 세션**이 자동 생성된다. 이건 A2A의 `agent:eden:a2a:{uuid}` 격리와 동등한 수준이지만, **풀 컨텍스트**를 유지한다.

### 6.2 부트스트랩 컨텍스트 비교

```
A2A 세션 (agent:eden:a2a:uuid):        스레드 세션 (agent:eden:discord:channel:threadId):
  AGENTS.md     ✅                        AGENTS.md       ✅
  TOOLS.md      ✅                        TOOLS.md        ✅
  IDENTITY.md   ✅                        IDENTITY.md     ✅
  MEMORY.md     ❌                        MEMORY.md       ✅  ← 이전 결정, 교훈
  SOUL.md       ❌                        SOUL.md         ✅  ← 성격, 말투
  USER.md       ❌                        USER.md         ✅
  CURRENT_TASK.md ❌                      CURRENT_TASK.md ✅  ← 현재 작업 상태
  HEARTBEAT.md  ❌                        HEARTBEAT.md    ⚠️  ← 아래 참고
```

**HEARTBEAT.md 문제**: A2A에서 MEMORY.md를 뺀 원래 이유는 HEARTBEAT.md가 에이전트를 `HEARTBEAT_OK` 응답으로 유도해서 A2A 대화를 방해했기 때문이다.

**해결**: 스레드 세션에서 HEARTBEAT.md만 제외하는 필터 추가.

```typescript
// workspace.ts에 추가
const THREAD_SESSION_DENYLIST = new Set(["HEARTBEAT.md"]);

// 스레드 세션(discord:channel:*) 판별 시 HEARTBEAT만 제외
if (isDiscordThreadSessionKey(sessionKey)) {
  return files.filter((file) => !THREAD_SESSION_DENYLIST.has(file.name));
}
```

---

## 7. 동기 vs 비동기 전환의 의미

### 7.1 sessions_send: 동기 대화

```
루다: sessions_send("eden", "코드 리뷰 해줘")
  → 루다가 블로킹됨 (이든 응답 대기)
  → 이든 응답 수신
  → 핑퐁 오케스트레이터가 자동으로 대화 진행 (최대 30턴)
  → 대화 완료 후 루다에게 최종 결과 반환
```

### 7.2 discord_send: 비동기 대화

```
루다: discord_send("eden", "코드 리뷰 해줘")
  → Discord 스레드에 메시지 전송
  → 즉시 반환: "메시지 전송 완료. 스레드: #프로젝트 > [검토] 인증 코드 리뷰"
  → 루다는 다른 작업 계속 가능

  (잠시 후)
  이든 봇이 스레드에서 멘션 감지 → 처리 → 응답
  → 루다는 스레드 알림 또는 다음 Self-Driving 사이클에서 확인
```

### 7.3 비동기의 장단점

| 장점                                    | 단점                                     |
| --------------------------------------- | ---------------------------------------- |
| 루다가 블로킹되지 않음 → 병렬 작업 가능 | 즉각적인 대화 흐름이 아님                |
| 자연스러운 비동기 협업 (사람처럼)       | "대화를 주고받아야 하는" 경우 턴 간 지연 |
| Discord 스레드가 기록으로 남음          | Discord API 지연                         |
| 사람이 끼어들기 쉬움                    | 핑퐁 자동화가 필요하면 별도 구현 필요    |

### 7.4 핑퐁이 필요한 경우의 대안

일부 시나리오(설계 논의, 브레인스토밍)에서는 여러 턴 대화가 필요하다.

**방법 A: 에이전트가 스스로 대화를 이어감**

- 이든이 스레드에 응답할 때, 루다에 대한 질문을 @멘션으로 포함
- 루다 봇이 멘션을 감지 → 응답 → 이든이 다시 감지 → ...
- Loop Guard(6msg/60s)가 자연스러운 속도 제한 역할

**방법 B: sessions_send 유지 (폴백)**

- 빠른 동기 대화가 필요한 경우 기존 sessions_send를 폴백으로 유지
- 에이전트 AGENTS.md에 "간단한 확인은 discord_send, 심층 논의는 sessions_send" 가이드

**추천**: 방법 A를 기본으로, sessions_send는 즉시 제거하지 않고 당분간 유지.

---

## 8. 전체 메시지 흐름 다이어그램

### 8.1 에이전트 → 에이전트 (Discord 스레드 경유)

```
  루다 봇              Discord               이든 봇
    │                    │                      │
    │  discord_send      │                      │
    │  (eden, msg)       │                      │
    │                    │                      │
    │  sendMessageDiscord│                      │
    │  @이든 코드 리뷰   │                      │
    │───────────────────▶│                      │
    │                    │                      │
    │  ResponseTracker   │                      │
    │  → pending         │                      │
    │                    │  MESSAGE_CREATE       │
    │                    │─────────────────────▶│
    │  (루다는 다른      │                      │
    │   작업 계속)       │  preflightDiscordMessage()
    │                    │  → 형제 봇 멘션 허용  │
    │                    │  → resolveAgentRoute()│
    │                    │  → eden, 풀 컨텍스트  │
    │                    │                      │
    │                    │  processDiscordMessage()
    │                    │  → MEMORY.md ✅       │
    │                    │  → SOUL.md ✅         │
    │                    │  → LLM 호출           │
    │                    │                      │
    │                    │  deliverDiscordReply() │
    │                    │◀─────────────────────│
    │                    │  💻이든: 확인했습니다  │
    │                    │                      │
    │  ResponseTracker   │                      │
    │  → responded ✅    │                      │
    │                    │                      │
```

### 8.2 무응답 → 재시도 → 에스컬레이션

```
  루다 봇          Discord 스레드      A2ARetryScheduler      병욱
    │                  │                     │                  │
    │  @이든 요청      │                     │                  │
    │─────────────────▶│                     │                  │
    │  pending 등록    │                     │                  │
    │                  │                     │                  │
    │                  │  (5분 경과, 무응답)   │                  │
    │                  │                     │                  │
    │                  │  [리마인더 1/3]       │                  │
    │                  │◀────────────────────│                  │
    │                  │  @이든 확인 부탁      │                  │
    │                  │                     │                  │
    │                  │  (5분 경과, 무응답)   │                  │
    │                  │                     │                  │
    │                  │  [리마인더 2/3]       │                  │
    │                  │◀────────────────────│                  │
    │                  │                     │                  │
    │                  │  (5분 경과, 3회 실패) │                  │
    │                  │                     │                  │
    │                  │  ⚠️ 에스컬레이션      │                  │
    │                  │◀────────────────────│                  │
    │                  │  @병욱 확인 필요      │────────────────▶│
    │                  │                     │                  │
```

### 8.3 사람 개입

```
  병욱          Discord 스레드         Gateway             이든 봇
    │                │                   │                    │
    │  (루다-이든 대화 진행 중인 스레드)                        │
    │                │                   │                    │
    │  "@이든 이건   │                   │                    │
    │   이렇게 해"   │                   │                    │
    │───────────────▶│                   │                    │
    │                │                   │                    │
    │                │  기존 파이프라인    │                    │
    │                │  (사람 메시지이므로 │                    │
    │                │   봇 필터 안 걸림) │                    │
    │                │──────────────────▶│                    │
    │                │                   │                    │
    │                │  세션: agent:eden:discord:channel:{threadId}
    │                │  → 이전 루다-이든 대화 히스토리 포함     │
    │                │  → 병욱 메시지 추가                     │
    │                │  → LLM 호출 ─────────────────────────▶│
    │                │                   │                    │
    │                │                   │◀── 응답 ──────────│
    │  ◀─────────── │  💻이든: "네,      │                    │
    │                │  그렇게 하겠습니다" │                    │
```

---

## 9. 수정할 파일 (최소 변경)

### 9.1 필수 수정 (Phase 1)

| 파일                                               | 변경                                                   | 규모  |
| -------------------------------------------------- | ------------------------------------------------------ | ----- |
| `src/discord/monitor/message-handler.preflight.ts` | 봇 필터에 "스레드 내 형제 봇 멘션 허용" 조건 추가      | ~15줄 |
| `src/discord/monitor/message-handler.preflight.ts` | 형제 봇 응답 시 `ResponseTracker.markResponded()` 호출 | ~5줄  |
| `src/discord/loop-guard.ts`                        | `isSystemRetry` 옵션 추가                              | ~3줄  |

### 9.2 새로 생성 (Phase 1)

| 파일                                    | 역할                    |
| --------------------------------------- | ----------------------- |
| `src/agents/tools/discord-send-tool.ts` | `discord_send` MCP 도구 |
| `src/discord/a2a-retry/tracker.ts`      | ResponseTracker         |
| `src/discord/a2a-retry/scheduler.ts`    | A2ARetryScheduler       |
| `src/discord/a2a-retry/utils.ts`        | 설정 기본값, 헬퍼       |

### 9.3 선택적 수정 (Phase 2)

| 파일                            | 변경                                        | 규모  |
| ------------------------------- | ------------------------------------------- | ----- |
| `src/agents/workspace.ts`       | 스레드 세션에서 HEARTBEAT.md 제외           | ~5줄  |
| `src/gateway/server-startup.ts` | A2ARetryScheduler 시작/중지 등록            | ~10줄 |
| `src/config/types.ts`           | `threadCommunication`, `a2aRetry` 타입 추가 | ~20줄 |

**총 변경량**: 기존 코드 수정 ~30줄 + 새 파일 4개. 기존 파이프라인을 **재활용**하기 때문에 변경이 최소.

---

## 10. Configuration

```jsonc
{
  "discord": {
    "threadCommunication": {
      "enabled": true,
      // 형제 봇이 스레드에서 우리 봇을 멘션할 때 에이전트 처리 허용
      "allowSiblingMentionsInThreads": true,
      // 사람이 스레드에서 우리 봇을 멘션할 때 에이전트 처리 허용
      // (이건 기존 파이프라인이 이미 하므로 별도 설정 불필요할 수 있음)
      "allowHumanMentionsInThreads": true,
    },

    "a2aRetry": {
      "enabled": true,
      "responseTimeoutMs": 300000, // 5분 무응답 판정
      "maxAttempts": 3, // 최대 재시도
      "checkIntervalMs": 60000, // 60초 폴링
      "cleanupMaxAgeMs": 86400000, // 24시간 정리
      "escalationMentionId": "974537452750528553", // 병욱 Discord ID
      "notifyOnFailure": true,
    },
  },
}
```

---

## 11. Migration Steps

### Phase 1: 양방향 통신 (핵심)

**목표**: Discord 스레드에서 에이전트 간 실제 통신 가능

1. `message-handler.preflight.ts` 수정 — 형제 봇 스레드 멘션 허용
2. `discord-send-tool.ts` 구현 — 에이전트가 Discord 스레드에 메시지 보내는 도구
3. 에이전트 AGENTS.md에 `discord_send` 사용 가이드 추가
4. 기존 `sessions_send`는 유지 (공존)

**검증**:

- 루다가 `discord_send`로 이든에게 메시지 → 이든이 스레드에서 처리 → 응답 확인
- 이든의 응답에 MEMORY.md 내용이 반영되는지 확인 (A2A와의 차이)
- 병욱이 같은 스레드에 개입 → 이든이 인식하고 응답하는지 확인

### Phase 2: 전달 보장

**목표**: 무응답 시 재시도, 최종 실패 시 에스컬레이션

1. `a2a-retry/tracker.ts` 구현
2. `a2a-retry/scheduler.ts` 구현
3. `server-startup.ts`에 스케줄러 등록
4. `loop-guard.ts`에 `isSystemRetry` 추가
5. preflight에 `markMentionResponded()` 연동

**검증**:

- 이든이 5분 무응답 → 리마인더 발송 확인
- 3회 실패 → 병욱에게 에스컬레이션 확인
- 이든 응답 시 → responded 전환 확인

### Phase 3: sessions_send 단계적 전환

**목표**: 에이전트들이 discord_send를 기본으로 사용

1. AGENTS.md에서 `sessions_send` 대신 `discord_send` 우선 사용 가이드
2. `sessions_send` 호출 시 Discord 미러링은 유지 (DiscordConversationSink)
3. 모니터링: discord_send vs sessions_send 사용 비율 추적
4. 안정화 후 sessions_send를 deprecated로 표시

**주의**: sessions_send를 완전 제거하지는 않음. 서브에이전트 spawn, 긴급 동기 통신 등에서 여전히 유용.

---

## 12. Risk & Mitigation

| 리스크                          | 영향                                         | 완화                                                     |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| **Discord API 지연 (3-10초)**   | 대화 속도 저하                               | 비동기 모델이므로 블로킹 없음. 에이전트는 다른 작업 병행 |
| **Discord API 레이트 리밋**     | 메시지 전송 실패                             | 기존 send.outbound.ts의 레이트 리밋 핸들링 재활용        |
| **Discord 장애**                | 통신 불가                                    | sessions_send를 폴백으로 유지                            |
| **HEARTBEAT.md 간섭**           | 스레드 세션에서 에이전트가 HEARTBEAT_OK 반응 | 스레드 세션 denylist에 HEARTBEAT.md 추가                 |
| **루프 (형제 봇 멘션 순환)**    | 무한 대화                                    | Loop Guard 6msg/60s + 멘션 없는 응답은 무시              |
| **이중 처리 (RPC + Discord)**   | 전환 기간 중 중복                            | source 태깅 + 전환 기간 가이드라인                       |
| **스레드 세션 컨텍스트 윈도우** | 오래된 스레드에 히스토리 과다                | 세션 자동 요약/정리 (기존 OpenClaw 세션 관리 활용)       |

---

## 13. 장기 비전: A2A 대화 요약 & 크로스 스레드 기억

Phase 1-3 완료 후 추가 가능:

### 13.1 대화 요약 자동 저장

```
스레드가 24시간 비활성 or 50개 메시지 도달
  │
  ▼
LLM이 대화 요약 생성:
  - 참여 에이전트
  - 주제
  - 결론/합의사항
  - 미해결 이슈
  - 액션 아이템
  │
  ▼
각 에이전트의 MEMORY.md에 자동 추가:
  "## 2026-02-26 [이든과 논의] 인증 시스템 설계
   결론: JWT + Refresh Token 방식 채택. 이든이 구현 담당."
```

### 13.2 크로스 스레드 컨텍스트

```
새 스레드 시작 시, 같은 에이전트 쌍의 최근 스레드 요약을
extraSystemPrompt로 주입:

"이전 관련 대화:
 - [2/25] 인증 시스템 설계: JWT 방식 합의
 - [2/24] API 구조 논의: RESTful + GraphQL 하이브리드"
```

이건 Discord 스레드 기반 통신이 안정화된 후에 추가하는 것이 적절.
