# Agent Collaboration v2: Handler/Observer + Standalone collaborate Tool

> **Status**: Draft v2 (피드백 반영)
> **Date**: 2026-02-26
> **Author**: 병욱
> **Scope**: prontolab-openclaw (gateway)

---

## 관련 문서

| 문서                                   | 내용                                                     |
| -------------------------------------- | -------------------------------------------------------- |
| `AGENT-COLLABORATION-V2-POLICIES.md`   | 런타임 정책 — Sink 분리, Observer 제한, 레이트리밋, 보안 |
| `AGENT-COLLABORATION-V2-OPS.md`        | 운영/복구/마이그레이션                                   |
| `AGENT-COLLABORATION-V2-VALIDATION.md` | 검증 시나리오                                            |

이 문서는 **핵심 설계**를 다룬다. 정책, 운영, 검증은 각 컴패니언 문서를 참조.

---

## 1. Problem

### 1.1 현재 구현의 근본적 결함

v1 (agentSend)을 실제 배포 후 발견한 문제들:

| 문제                                  | 원인                                                                                   | 영향                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| **모든 봇이 모든 메시지 처리**        | Discord는 채널의 모든 봇에게 MESSAGE_CREATE 전달. `requireMention` 미설정 시 전부 처리 | @루다한테 보낸 메시지를 다짐이 처리     |
| **requireMention 딜레마**             | `true` 설정 → 멘션 없는 메시지 무시 → 채널 인지 상실. `false` → 중복 처리              | 어떻게 설정해도 문제                    |
| **agentSend가 discord_action에 종속** | `discord_action`은 Discord 채널 세션에서만 사용 가능. A2A/webchat 세션에서 불가        | 에이전트가 Discord 채널에서만 협업 가능 |
| **LLM 판단에 100% 의존**              | "이든한테 물어봐줘" → LLM이 `discord_action(agentSend)` 호출해야 하는데 보장 없음      | 자연어 요청이 협업으로 이어지지 않음    |
| **accountId ≠ agentId 매핑 깨짐**     | `registerSiblingBot(botUserId, accountId)` vs `getBotUserIdForAgent(agentId)`          | agentSend 실행 시 대상 봇 못 찾음       |

### 1.2 근본 원인

기존 설계는 **Discord 메시지 파이프라인 위에 A2A를 얹으려** 했지만, 파이프라인의 두 가지 전제를 간과했다:

1. **모든 봇이 독립적으로 메시지를 수신한다** — 채널의 봇 5개면 같은 메시지가 5번 처리됨
2. **도구 가용성이 세션 타입에 종속된다** — `discord_action`은 채널 플러그인 도구라서 Discord 채널 세션에서만 존재

---

## 2. 설계 원칙

1. **Handler/Observer 분리**: 멘션된 봇만 응답하고, 나머지는 관찰만 한다
2. **도구 독립성**: 협업 도구는 세션 타입에 무관하게 항상 사용 가능하다
3. **Discord 네이티브 유지**: sessions_send로 회귀하지 않는다. Discord 스레드가 통신 채널이다
4. **코드 레벨 보장**: LLM 판단만으로는 불충분하다. 라우팅과 전달은 코드가 보장한다
5. **채널 인지 보존**: 멘션 안 된 봇도 채널 대화를 "본다" (히스토리에 기록)

---

## 3. 핵심 개념: Handler / Observer

### 3.1 현재 (모든 봇이 Handler)

```
User: "@루다 이든한테 물어봐줘"

루다 봇: MESSAGE_CREATE 수신 → preflightDiscordMessage() → process → 응답 ✅
다짐 봇: MESSAGE_CREATE 수신 → preflightDiscordMessage() → process → 응답 ❌ (의도하지 않은 처리)
이든 봇: MESSAGE_CREATE 수신 → preflightDiscordMessage() → process → 응답 ❌
세움 봇: MESSAGE_CREATE 수신 → preflightDiscordMessage() → process → 응답 ❌
```

### 3.2 목표 (멘션 대상만 Handler, 나머지 Observer)

```
User: "@루다 이든한테 물어봐줘"

루다 봇: MESSAGE_CREATE → preflight → HANDLER 모드 → process → 응답 ✅
다짐 봇: MESSAGE_CREATE → preflight → OBSERVER 모드 → 히스토리 기록만 → 응답 안 함
이든 봇: MESSAGE_CREATE → preflight → OBSERVER 모드 → 히스토리 기록만 → 응답 안 함
세움 봇: MESSAGE_CREATE → preflight → OBSERVER 모드 → 히스토리 기록만 → 응답 안 함
```

### 3.3 Observer 모드의 의미

Observer는 메시지를 **무시**하는 게 아니라 **인지**한다:

- 세션 히스토리에 메시지가 기록됨 (다음 대화에서 참조 가능)
- 에이전트 처리(LLM 호출)는 하지 않음
- Discord 응답도 보내지 않음

이것이 `requireMention: true`와 다른 점:

- `requireMention: true`: 메시지를 아예 드랍 → 히스토리에도 안 남음
- **Observer 모드**: 메시지를 기록하되 처리하지 않음 → 채널 인지 유지

### 3.4 Handler 결정 로직

```
메시지 도착
  │
  ├── 길드/채널 허용 검증 (POLICIES.md §6 참조)
  │   └── allowedChannels/allowedGuilds 체크 → 미허용 시 무시
  │
  ├── Sink 스레드인가? (POLICIES.md §2 참조)
  │   └── YES → 드랍 (Handler/Observer 모두 아님)
  │
  ├── 스레드 메시지인가?
  │   │
  │   ├── 내가 이 스레드의 "참여자"인가?
  │   │   └── YES → HANDLER (멘션 없어도 처리 + 응답)
  │   │
  │   ├── 내가 이 메시지에서 @멘션됐나?
  │   │   └── YES → HANDLER + 참여자로 등록
  │   │
  │   └── 아니면 → OBSERVER (기록만)
  │
  ├── 채널 메시지인가? (스레드 아님)
  │   │
  │   ├── 특정 봇 @멘션 있음?
  │   │   ├── 내가 멘션됨 → HANDLER (처리 + 응답)
  │   │   └── 다른 봇 멘션됨 → OBSERVER (기록만)
  │   │
  │   └── 아무 봇도 멘션 안 됨?
  │       └── 기존 로직 유지 (binding/default agent)
  │
  └── DM?
      └── 기존 로직 유지
```

**참여자 등록은 정확히 3가지 경우로 고정:**

1. `collaborate()`가 스레드를 생성/사용할 때 — `from` 에이전트와 `target` 에이전트 **둘 다** 등록
2. 스레드에서 **멘션된** 봇은 등록
3. 스레드에서 실제로 **메시지를 보낸(응답한)** 봇은 등록

**mid-thread 신규 에이전트 합류:**

- 사용자 또는 에이전트가 스레드에서 기존에 없던 에이전트를 @멘션하면 → 해당 봇이 참여자로 등록 + HANDLER 전환
- collaborate()의 초대와 동일한 효과 — 이후 해당 에이전트는 멘션 없이 스레드에서 자동 처리

### 3.5 스레드 참여자 (Thread Participant)

**협업 스레드는 멘션 없이도 동작한다.**

스레드는 `collaborate` 도구로 생성된 협업 공간이므로, 한번 참여한 에이전트는 이후 멘션 없이도 메시지를 처리한다.

**참여자 등록 조건** (3.4와 동일, 3가지로 고정):

- `collaborate()` 도구로 이 스레드를 생성했음 (발신자 + 대상 모두)
- 스레드 내에서 @멘션된 적 있음
- 스레드 내에서 메시지를 보낸 적 있음 (응답한 적 있음)

**구현:**

```typescript
// ThreadParticipantMap — 스레드별 참여 에이전트 추적
// 저장: in-memory Map + 디스크 캐시 (gateway 재시작 대응)
// 경로: state/thread-participants.json

interface ThreadParticipants {
  threadId: string;
  participants: Set<string>; // botUserId 집합
  createdAt: number;
  lastActivityAt: number;
}

// 참여자 등록 시점:
// 1. collaborate() 호출 시 — 발신자 + 대상 에이전트 모두 등록
// 2. 스레드에서 멘션 감지 시 — 멘션된 봇 등록
// 3. 스레드에서 메시지 전송 시 — 발신 봇 등록
```

**영속성 (Persistence):**

- 파일 기반 캐시: `state/thread-participants.json` (a2a-mention-tracking.json과 동일한 패턴)
- in-memory Map + 디스크 캐시 병행 — gateway 재시작 후 복구 가능
- **재시작 시 캐시 없을 경우 안전 저하(safe degradation)**: "멘션 기반 HANDLER만" 모드로 동작 (참여자 이력 없이도 @멘션에는 반응)
- **TTL**: 마지막 활동 후 24시간이 지난 스레드의 참여자 정보는 만료 처리

**예시:**

```
1. 루다가 collaborate(eden, "코드 리뷰 해줘") 호출
   → 스레드 생성, 참여자: {루다, 이든}

2. 이든이 스레드에서 응답 (멘션 없이)
   → 이든은 참여자이므로 HANDLER ✅

3. 루다가 스레드에서 "고마워, 한 가지 더 확인해줘" (멘션 없이)
   → 이든은 참여자이므로 이 메시지를 HANDLER로 처리 ✅

4. 루다가 스레드에서 "@세움 도 확인해봐"
   → 세움이 참여자로 등록됨
   → 이후 세움도 멘션 없이 스레드에서 HANDLER

5. 다짐은 이 스레드에 참여한 적 없음
   → OBSERVER (스레드 메시지 무시)
```

### 3.6 채널에서의 멘션 규칙

**채널(스레드 아님)에서는 반드시 대상을 @멘션해야 한다.**

Handler/Observer가 올바르게 동작하려면:

- 사람이 에이전트에게 말할 때: `@루다 이것 좀 확인해줘`
- 에이전트가 다른 에이전트에게 말할 때: `collaborate()` 도구 사용 (자동 멘션)
- 에이전트가 채널에 직접 응답할 때: 대상이 있으면 반드시 @멘션 포함

**멘션 없는 채널 메시지**: 기존 `resolveAgentRoute()` 로직대로 binding/default agent가 처리.
이것은 "특정 에이전트에게 말하는 것"이 아니라 "채널 전체에 말하는 것"으로 간주.

**에이전트의 채널 발언 규칙 (AGENTS.md에 반영):**

```
- 채널에서 다른 에이전트와 대화하려면 반드시 collaborate() 사용
- 채널에 직접 메시지를 쓸 때 특정 에이전트를 지목하려면 @멘션 포함
- 스레드 안에서는 멘션 없이 자유롭게 대화 가능
```

### 3.7 다중 에이전트 동시 멘션 처리

사용자가 여러 에이전트를 동시에 멘션하는 경우: `"@루다 @이든 이거 같이 봐줘"`

**처리 규칙:**

- **첫 번째 멘션 에이전트 = PRIMARY** — 이 요청의 주 담당
- **이후 멘션 에이전트 = SECONDARY** — 보조 역할

**순서 보장: best-effort (보장하지 않음)**

> 두 봇은 동시에 MESSAGE_CREATE를 수신하고 동시에 LLM을 호출하므로, PRIMARY가 반드시 먼저 응답한다는
> 보장은 없다. 시스템 힌트로 유도하지만, LLM 응답 시간이 비결정적이라 SECONDARY가 먼저 나올 수 있다.
> 이 기능의 핵심은 **"둘 다 HANDLER로 처리"**이지 응답 순서가 아니다.

**구현:**

- 메시지 content에서 멘션 순서대로 파싱 (텍스트 등장 순서 기준)
- 첫 번째 매칭 = primary, 나머지 = secondary

**시스템 힌트 주입:**

```typescript
// primary 에이전트에게
systemHint = "당신이 이 요청의 주 담당입니다. 리드하여 응답하세요.";

// secondary 에이전트에게
systemHint = `당신은 보조 역할입니다. ${primaryAgentName}의 응답이 있으면 참고하여 보완 의견을 제시하세요.`;
```

**예시:**

```
User: "@루다 @이든 이거 같이 봐줘"

→ 루다: PRIMARY (리드, "제가 먼저 살펴볼게요...")
→ 이든: SECONDARY (보조, "루다 의견에 덧붙이면..." — 순서는 best-effort)
→ 둘 다 HANDLER로 응답하는 것이 핵심
```

---

## 4. 핵심 개념: `collaborate` 도구

### 4.1 왜 discord_action이 아닌 standalone 도구인가

|                 | discord_action (agentSend)       | collaborate (신규)                          |
| --------------- | -------------------------------- | ------------------------------------------- |
| **가용 세션**   | Discord 채널 세션만              | **모든 세션** (discord, webchat, a2a, main) |
| **구현 위치**   | 채널 플러그인 도구               | 에이전트 코어 도구 (sessions_send와 동급)   |
| **Discord API** | 채널 플러그인 컨텍스트 경유      | REST API 직접 호출                          |
| **실패 모드**   | "discord_action 도구가 없습니다" | 항상 사용 가능, Discord API 실패만 처리     |

### 4.2 도구 스키마

```typescript
// src/agents/tools/collaborate-tool.ts

interface CollaborateInput {
  targetAgent: string; // 대상 에이전트 ID (필수) — "eden", "ruda", "seum" 등
  message: string; // 전달할 메시지 (필수)
  threadId?: string; // 기존 스레드에 이어쓰기 (선택)
  channelId?: string; // 새 스레드를 만들 채널 (선택, 미지정 시 기본 채널)
  threadName?: string; // 새 스레드 이름 (선택)
}

interface CollaborateOutput {
  success: boolean;
  threadId: string; // 메시지가 게시된 스레드 ID
  threadName: string; // 스레드 이름
  channelId: string; // 부모 채널 ID
  messageId: string; // Discord 메시지 ID
  note: string; // "이든에게 메시지를 전달했습니다. 스레드에서 응답을 기다리세요."
}
```

### 4.3 동작 흐름

```
에이전트 A가 collaborate(targetAgent: "eden", message: "코드 리뷰 해줘") 호출
  │
  ├── 1. 대상 봇 Discord ID 조회
  │     resolveAgentBotUserId("eden")
  │     → agentId → accountId 매핑 테이블 → botUserId
  │     (registerSiblingBot 매핑 + agent config에서 account 매핑 보완)
  │
  ├── 2. 스레드 결정
  │     ├── threadId 지정됨 → 기존 스레드 사용
  │     └── threadId 없음 → 새 스레드 생성
  │           │
  │           ├── discordAccountId 결정 (우선순위):
  │           │     명시 인자 > 현재 세션 accountId > config의 default
  │           │
  │           ├── channelId 결정 (우선순위):
  │           │     명시 인자 > 현재 세션의 채널 > config의 "협업 기본 채널"
  │           │     (discordConfig.collaboration.defaultChannel)
  │           │
  │           ├── 허용 채널 검증:
  │           │     "협업 기본 채널 + allowlist" 외에는 스레드 생성 금지
  │           │     (discordConfig.collaboration.allowedChannels: string[])
  │           │
  │           └── threadName = 지정값 or 자동 생성 "[협업] {fromAgent} → {targetAgent}"
  │
  ├── 3. Discord 메시지 전송
  │     sendMessageDiscord(threadId, "<@{botUserId}>\n\n{message}")
  │     → 기존 send.ts의 레이트리밋/청킹 재활용
  │
  ├── 4. ResponseTracker 등록 (Phase 2: pending 상태만 등록, Phase 3: reminder/escalation 추가)
  │     trackOutboundMention({ threadId, targetAgent, messageId, sentAt, ... })
  │     // Phase 2에서는 "pending 등록"만 수행 (응답 감지는 preflight에서 처리)
  │     // Phase 3에서 reminder 스케줄러 + escalation이 이 위에 추가됨
  │
  └── 5. 즉시 반환 (비동기)
        → { success: true, threadId, note: "이든에게 메시지를 전달했습니다..." }
```

### 4.4 agentId → botUserId 매핑 수정 (이중 등록 + 2단계 조회)

**문제:**

```typescript
// provider.ts:536 — accountId로 등록
registerSiblingBot(botUserId, account.accountId);
// "default" → botUserId

// discord-send-tool.ts:43 — agentId로 조회
getBotUserIdForAgent("eden");
// "eden" → ??? (매핑 없음, "default"만 등록됨)
```

**수정 — 이중 등록 (provider.ts):**

```typescript
// provider.ts — dual registration
registerSiblingBot(botUserId, account.accountId); // "default"
const agentId = resolveAgentId(cfg, account.accountId);
if (agentId !== account.accountId) {
  registerSiblingBot(botUserId, agentId); // "eden"
}
```

**2단계 조회 fallback (collaborate-tool.ts):**

```typescript
function resolveAgentBotUserId(agentId: string): string | null {
  // Stage 1: direct lookup by agentId
  const direct = getBotUserIdForAgent(agentId);
  if (direct) return direct;

  // Stage 2: config binding fallback (agentId → accountId → botUserId)
  const binding = findBindingForAgent(agentId, "discord");
  if (binding?.accountId) {
    return getBotUserIdForAgent(binding.accountId);
  }

  return null; // → collaborate returns error to caller
}
```

조회 실패 시 (`null` 반환): collaborate는 호출자에게 에러를 반환하고 안내 메시지 포함.

### 4.5 sessions_send와 collaborate의 관계

두 도구는 **병행(coexist)** 한다. 서로를 대체하는 게 아니다.

| 상황                                     | 사용 도구       | 이유                                |
| ---------------------------------------- | --------------- | ----------------------------------- |
| Discord 채널에서 다른 에이전트에게 질문  | `collaborate`   | 사용자가 스레드에서 대화 볼 수 있음 |
| 백그라운드 작업 위임 (사용자 안 봐도 됨) | `sessions_send` | A2A 내부 통신으로 충분              |
| webchat에서 에이전트 간 협업 시작        | `collaborate`   | Discord 스레드로 가시화             |
| A2A 세션 내 상태 전달                    | `sessions_send` | 세션 컨텍스트 직접 전달             |

- `sessions_send` (A2A direct): **내부 제어 플레인** — 세션 상태 전달, 비Discord 컨텍스트, 사용자 비가시
- `collaborate` (Discord thread): **사용자 가시 협업** — Discord 존재 필요, 스레드에서 대화 공개

> **참고**: 이 가이드라인은 AGENTS.md에도 반영해야 함 (Phase 4)

---

## 5. 수신 측: 형제 봇 멘션 처리

### 5.1 현재 (형제 봇 메시지 드랍)

```typescript
// message-handler.preflight.ts:101-142
if (isBot && !allowBots) {
  // 형제 봇이면 히스토리에만 기록
  // 에이전트 처리로는 넘기지 않음
  return null; // ← 드랍
}
```

### 5.2 목표 (스레드 내 형제 봇 멘션은 허용)

```typescript
if (isBot && !allowBots) {
  const isSibling = isSiblingBot(authorId);

  if (isSibling && isInThread && mentionsMe(message, botUserId)) {
    // 형제 봇이 스레드에서 우리를 멘션 → HANDLER로 처리
    // → processDiscordMessage()로 진행
    // → 풀 컨텍스트 (MEMORY, SOUL, IDENTITY 등)
    // → 스레드별 세션 격리: agent:{agentId}:discord:channel:{threadId}
  } else if (isSibling) {
    // 형제 봇 메시지지만 우리를 멘션하지 않음 → 히스토리만 기록
    recordSiblingMessage(message);
    // ResponseTracker: 응답 감지
    markMentionRespondedIfApplicable(threadId, authorId);
    return null;
  } else {
    // 일반 봇 (형제 아님) → 기존 동작
    return null;
  }
}
```

### 5.3 스레드 세션의 컨텍스트

스레드 세션 키: `agent:eden:discord:channel:{threadId}`

이 세션은 **풀 컨텍스트**를 로드한다:

- AGENTS.md ✅
- TOOLS.md ✅
- IDENTITY.md ✅
- MEMORY.md ✅ ← A2A 세션에서는 빠졌던 것
- SOUL.md ✅ ← A2A 세션에서는 빠졌던 것
- CURRENT_TASK.md ✅
- HEARTBEAT.md ❌ ← HEARTBEAT_OK 응답 방지를 위해 제외

`isA2ASessionKey()`가 false를 반환하므로 **코드 수정 없이** 풀 컨텍스트 로드. HEARTBEAT.md만 스레드 세션 denylist로 제외.

---

## 6. 전체 메시지 흐름

### 6.1 사용자 → 에이전트 A → 에이전트 B 협업

```
  사용자              루다 봇           Discord            이든 봇
    │                   │                 │                   │
    │  "@루다 이든한테   │                 │                   │
    │   물어봐줘"        │                 │                   │
    │──────────────────▶│                 │                   │
    │                   │                 │                   │
    │  [HANDLER 모드]    │                 │                   │
    │  LLM 호출         │                 │                   │
    │  → collaborate()  │                 │                   │
    │   사용 결정       │                 │                   │
    │                   │                 │                   │
    │                   │  collaborate()  │                   │
    │                   │  (eden, msg)    │                   │
    │                   │                 │                   │
    │                   │  스레드 생성 +   │                   │
    │                   │  @이든 멘션      │                   │
    │                   │────────────────▶│                   │
    │                   │                 │                   │
    │  "이든에게 전달    │                 │                   │
    │   했습니다"        │                 │                   │
    │◀──────────────────│                 │                   │
    │                   │                 │  MESSAGE_CREATE    │
    │                   │                 │  (스레드, @이든)    │
    │                   │                 │──────────────────▶│
    │                   │                 │                   │
    │                   │                 │  [HANDLER 모드]    │
    │                   │                 │  풀 컨텍스트 로드  │
    │                   │                 │  MEMORY+SOUL ✅    │
    │                   │                 │  LLM 호출         │
    │                   │                 │                   │
    │                   │                 │  스레드에 응답     │
    │                   │                 │◀──────────────────│
    │                   │                 │                   │
    │  ResponseTracker  │                 │                   │
    │  → responded      │                 │                   │
    │                   │                 │                   │
```

### 6.2 다짐 봇의 동작 (같은 채널에 있지만 Observer)

```
  사용자              다짐 봇
    │                   │
    │  "@루다 이든한테   │
    │   물어봐줘"        │
    │──────────────────▶│
    │                   │
    │  [OBSERVER 모드]   │
    │  히스토리 기록     │
    │  LLM 호출 안 함   │
    │  응답 안 함       │
    │                   │
    │  (다짐은 나중에    │
    │   "아까 루다가     │
    │    이든한테 물어봤다"│
    │   라는 컨텍스트를  │
    │   알고 있음)       │
```

### 6.3 멘션 없는 채널 메시지

```
  사용자              루다 봇(default)    다짐 봇            이든 봇
    │                   │                 │                   │
    │  "프론트엔드       │                 │                   │
    │   진행 어때?"      │                 │                   │
    │  (멘션 없음)       │                 │                   │
    │──────────────────▶│────────────────▶│──────────────────▶│
    │                   │                 │                   │
    │  [기존 로직]       │  [OBSERVER]     │  [OBSERVER]       │
    │  binding/default   │  히스토리만     │  히스토리만       │
    │  agent가 처리     │                 │                   │
```

멘션이 없는 경우: 기존 `resolveAgentRoute()` 로직대로 binding/default agent가 처리. 나머지는 Observer.

---

## 7. 응답 추적 (ResponseTracker)

### 7.1 구조

```typescript
interface TrackedCollaboration {
  id: string;
  threadId: string;
  fromAgentId: string;
  targetAgentId: string;
  targetBotId: string;
  messageId: string;
  originalMessage: string; // 500자 truncate
  status: "pending" | "responded" | "failed";
  sentAt: number;
  respondedAt?: number;
  attempts: number; // 리마인더 횟수
  lastAttemptAt: number;
}
```

### 7.2 응답 감지

`message-handler.preflight.ts`의 sibling bot 히스토리 기록 단계에서:

```typescript
if (isSiblingBot(authorId) && isInThread) {
  const responderAgentId = getAgentIdForBot(authorId);
  // threadId + targetAgentId + sentAt 이후 첫 응답을 매칭
  // 같은 스레드의 다른 요청까지 완료 처리되지 않도록 정밀 매칭
  markMentionResponded(threadChannelId, responderAgentId, {
    matchTargetAgent: true, // responder가 tracked의 targetAgentId와 일치해야 함
    afterTimestamp: true, // tracked의 sentAt 이후 메시지만 매칭
  });
}
```

> **주의**: thread + responder 기준만으로 responded 처리하면, 같은 스레드에서 동일 에이전트에 대한
> 여러 요청이 있을 때 오탐이 발생한다. `messageId` / `sentAt` 이후 첫 응답 / `targetAgentId`를
> 함께 매칭해야 정확한 응답 추적이 가능하다.

### 7.3 재시도 스케줄러

```
collaborate() 호출 → pending 등록
  │
  ├── 5분 내 응답 → responded ✅
  │
  ├── 5분 무응답 → 리마인더 1/3
  │   "[리마인더] @이든 위 요청 확인 부탁해요."
  │
  ├── 10분 무응답 → 리마인더 2/3
  │
  └── 15분 무응답 → 에스컬레이션
      "⚠️ @병욱 이든이 15분째 무응답입니다. 확인 필요."
```

---

## 8. 구현 계획

### Phase 1: Handler/Observer 라우팅 (핵심)

**목표**: 멘션 기반 라우팅으로 중복 처리 제거 + 스레드 참여자 자동 인식

| 파일                                               | 변경                                                                                 | 규모  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ | ----- |
| `src/discord/monitor/message-handler.preflight.ts` | 멘션 감지 후 HANDLER/OBSERVER 분기 추가                                              | ~30줄 |
| `src/discord/monitor/message-handler.preflight.ts` | Observer 모드: 히스토리 기록만, 처리 스킵                                            | ~15줄 |
| `src/discord/monitor/message-handler.preflight.ts` | 스레드 내 sibling bot 멘션 허용                                                      | ~15줄 |
| `src/discord/monitor/message-handler.preflight.ts` | 스레드 참여자 → 멘션 없이도 HANDLER                                                  | ~10줄 |
| `src/discord/monitor/thread-participants.ts`       | **새 파일** — ThreadParticipantMap (in-memory + state/thread-participants.json 영속) | ~80줄 |

**검증**:

- @루다 멘션 → 루다만 응답, 다짐/이든/세움은 Observer
- 멘션 없는 채널 메시지 → default agent만 응답
- 협업 스레드에서 멘션 없이 대화 → 참여자들만 HANDLER
- 스레드에 @세움 추가 → 세움도 참여자로 등록, 이후 멘션 없이 동작
- Observer 모드의 메시지가 다음 대화에서 참조 가능한지 확인
- gateway 재시작 후 캐시 복구 검증 (state/thread-participants.json)
- 캐시 없는 재시작 시 safe degradation (멘션 기반 HANDLER만) 검증

### Phase 2: collaborate 도구 (핵심)

**목표**: 세션 타입 무관하게 에이전트 간 Discord 스레드 통신

| 파일                                   | 변경                                        | 규모   |
| -------------------------------------- | ------------------------------------------- | ------ |
| `src/agents/tools/collaborate-tool.ts` | **새 파일** — collaborate 도구 구현         | ~120줄 |
| `src/agents/tools/index.ts`            | collaborate 도구 등록                       | ~3줄   |
| `src/discord/monitor/sibling-bots.ts`  | agentId → botUserId 역조회 보강             | ~20줄  |
| `src/discord/monitor/provider.ts`      | registerSiblingBot에 agentId 이중 매핑 추가 | ~5줄   |
| `src/agents/workspace.ts`              | 스레드 세션 HEARTBEAT.md denylist           | ~5줄   |

**Phase 1-2 비동기 처리 주의사항:**

Phase 3 (ResponseTracker의 reminder/escalation)가 없는 Phase 1-2 배포 기간 동안 블로킹 리스크가 존재한다:

- Agent A가 collaborate()로 B에게 메시지를 보내고 응답을 기다리는 동안, 새 사용자 메시지가 도착할 수 있음
- **완화책**: collaborate()는 즉시 반환 (완전 비동기). 에이전트는 사용자에게 "이든에게 전달했습니다. 응답이 오면 스레드에서 확인하세요." 라고 안내 후 다른 메시지 처리를 계속함
- 에이전트는 B의 응답을 블로킹으로 기다리지 않는다
- **Phase 2에서는 최소한의 pending 상태 등록만** 수행 (collaborate 흐름의 step 4). 이를 통해 Phase 3에서 reminder/escalation을 추가할 때 기존 데이터를 활용할 수 있음
- Phase 3에서 proper reminder/escalation이 이 위에 추가된다

**검증**:

- 루다가 collaborate("eden", "코드 리뷰 해줘") → 스레드 생성 + @이든 멘션
- 이든이 스레드에서 풀 컨텍스트로 응답
- webchat/main 세션에서도 collaborate 사용 가능
- collaborate() 호출 후 즉시 반환, 사용자에게 전달 안내 메시지 확인

### Phase 3: 응답 추적 + 재시도

**목표**: 무응답 시 리마인더, 최종 실패 시 에스컬레이션

| 파일                                               | 변경                              | 규모  |
| -------------------------------------------------- | --------------------------------- | ----- |
| `src/discord/a2a-retry/tracker.ts`                 | 기존 파일 수정 — collaborate 연동 | ~30줄 |
| `src/discord/a2a-retry/scheduler.ts`               | 기존 파일 수정 — 리마인더 로직    | ~20줄 |
| `src/discord/monitor/message-handler.preflight.ts` | markMentionResponded 연동         | ~5줄  |

### Phase 4: AGENTS.md 업데이트 + agentSend 정리

**목표**: 에이전트들이 collaborate를 자연스럽게 사용하도록 유도

| 파일                                            | 변경                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 11개 에이전트 AGENTS.md                         | `agentSend` → `collaborate` 교체                                                                   |
| `src/agents/tools/discord-actions-messaging.ts` | agentSend case 제거 (또는 collaborate로 리다이렉트)                                                |
| `src/agents/tools/discord-send-tool.ts`         | collaborate-tool.ts로 통합 후 제거                                                                 |
| 정책 문서 단일화                                | COLLABORATION.md, AGENTS.md의 협업 섹션을 Discord-first + collaborate 기준으로 통합 (상세: OPS.md) |
| `sessions-send-helpers.ts:212`                  | A2A 컨텍스트의 "외부 채널 협업 금지" 문구 수정 — sessions_send와 collaborate 병행 정책 반영        |

---

## 9. v1 (agentSend) 코드 정리

Phase 4에서 정리할 v1 코드:

| 파일                                               | 처리                                             |
| -------------------------------------------------- | ------------------------------------------------ |
| `src/agents/tools/discord-send-tool.ts`            | 삭제 (collaborate-tool.ts로 대체)                |
| `src/agents/tools/discord-actions-messaging.ts`    | `case "agentSend"` 제거                          |
| `src/agents/tools/discord-actions.ts`              | `messagingActions`에서 `"agentSend"` 제거        |
| `src/discord/a2a-retry/`                           | 유지 (collaborate에서 재활용)                    |
| `src/discord/loop-guard.ts`                        | `isSystemRetry` 유지                             |
| `src/discord/monitor/message-handler.preflight.ts` | `markMentionResponded` 유지 (Phase 1에서 재활용) |

---

## 10. AGENTS.md collaborate 가이드

```markdown
## Peer Collaboration — collaborate 도구

다른 에이전트와 소통이 필요할 때 `collaborate` 도구를 사용합니다.

### 사용법

collaborate({
targetAgent: "eden",
message: "인증 모듈 코드 리뷰 부탁해. PR #42 확인해줘.",
threadName: "인증 모듈 코드 리뷰"
})

### 언제 사용하나

- 사용자가 "이든한테 물어봐줘", "세움이랑 논의해봐" 등 다른 에이전트 협업을 요청할 때
- 작업 중 다른 에이전트의 전문 영역이 필요할 때
- 정보를 다른 에이전트에게 전달해야 할 때
- Discord에서 사용자가 볼 수 있는 협업이 필요할 때

### collaborate vs sessions_send

- `collaborate`: Discord 스레드 생성, 사용자 가시, 에이전트 간 공개 협업
- `sessions_send`: A2A 내부 통신, 사용자 비가시, 백그라운드 위임

### 동작 방식

1. Discord 스레드가 생성되고 대상 에이전트가 멘션됩니다
2. 대상 에이전트가 스레드에서 풀 컨텍스트로 응답합니다
3. 비동기 — 보내고 바로 다른 작업을 계속할 수 있습니다
4. 스레드 참여자는 이후 멘션 없이 자유롭게 대화할 수 있습니다

### 스레드 대화 규칙

- 스레드 안에서는 멘션 없이 자유롭게 대화 가능 (참여자 자동 인식)
- 스레드에 새 에이전트를 초대하려면 @멘션 사용 (예: "@세움 이것도 확인해줘")
- 스레드 밖(채널)에서 다른 에이전트에게 말하려면 반드시 collaborate() 사용

### 채널 발언 규칙 (CRITICAL)

- 채널에서 다른 에이전트와 대화하려면 반드시 collaborate() 사용
- 채널에 직접 메시지를 쓸 때 특정 에이전트를 지목하려면 @멘션 포함
- 멘션 없이 채널에 쓰면 기본 에이전트만 반응하고 나머지는 무시함

### 주의사항

- targetAgent는 에이전트 ID (eden, seum, dajim 등)
- 기존 스레드에 이어서 대화하려면 threadId를 지정하세요
- 백그라운드 위임(사용자 안 봐도 됨)은 sessions_send를 사용하세요
```

---

## 11. Risk & Mitigation

| 리스크                             | 영향                                                    | 완화                                                                         |
| ---------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Observer 모드 히스토리 과다**    | 채널 메시지가 모든 봇 세션에 쌓임                       | Observer 메시지는 compact한 형태로 기록 (발신자 + 요약만) (POLICIES.md 참조) |
| **collaborate 도구를 LLM이 안 씀** | 자연어 요청이 협업으로 안 이어짐                        | AGENTS.md에 명확한 가이드 + 에이전트 이름 감지 시 시스템 힌트 주입           |
| **Discord API 레이트리밋**         | 스레드 생성/메시지 전송 실패                            | 기존 send.ts의 레이트리밋 핸들링 재활용                                      |
| **스레드 폭발**                    | collaborate마다 새 스레드 → 채널 어지러움               | 재사용 정책 + TTL 캐시 (POLICIES.md 참조)                                    |
| **루프 (A ↔ B 무한 대화)**         | Loop Guard 6msg/60s 초과                                | 기존 Loop Guard 유지 + collaborate 응답에 대한 자동 collaborate 금지         |
| **A2A Sink 루프**                  | collaborate 스레드에 sink가 메시지 → 재처리 → 무한 핑퐁 | Sink 스레드와 협업 스레드 분리 (POLICIES.md 참조)                            |
| **Observer 히스토리 폭증**         | 10개 봇 × 채널 메시지 = 10배 저장                       | Observer는 compact 포맷만 (POLICIES.md 참조)                                 |
| **매핑 실패**                      | agentId↔botUserId 불일치                                | 이중 등록 + 2단계 fallback + 장애 시 안내 메시지                             |
| **정책 충돌**                      | COLLABORATION.md vs AGENTS.md vs 새 설계                | Phase 4에서 단일화 (OPS.md 참조)                                             |

---

## 12. v1 vs v2 비교

| 항목              | v1 (agentSend)                       | v2 (collaborate)                               |
| ----------------- | ------------------------------------ | ---------------------------------------------- |
| **라우팅**        | 모든 봇이 모든 메시지 처리           | Handler/Observer 분리                          |
| **도구 위치**     | discord_action 하위 (채널 세션 전용) | standalone 코어 도구 (모든 세션)               |
| **봇 ID 조회**    | accountId 매핑 (깨짐)                | agentId + accountId 이중 매핑 + 2단계 fallback |
| **채널 인지**     | 없음 (requireMention 딜레마)         | Observer 모드로 보존                           |
| **LLM 의존도**    | 100% (도구 호출 결정)                | 높지만 AGENTS.md 가이드 + 시스템 힌트 보완     |
| **세션 컨텍스트** | N/A (도구 자체가 안 됨)              | 풀 컨텍스트 (MEMORY, SOUL 포함)                |
| **참여자 영속성** | 없음                                 | state/thread-participants.json + TTL           |
| **비동기 처리**   | 미정의                               | 즉시 반환 + Phase 3에서 추적 추가              |

---

## 13. 구현 우선순위

```
Phase 1 (Handler/Observer) ← 가장 중요. 이것만으로도 중복 처리 해결
  │
  ▼
Phase 2 (collaborate 도구) ← 핵심 기능. 에이전트 간 실제 통신
  │
  ▼
Phase 3 (응답 추적) ← 안정성. 무응답 시 재시도
  │
  ▼
Phase 4 (정리) ← v1 코드 제거, AGENTS.md 업데이트, 정책 문서 단일화
```

Phase 1 + 2가 완료되면 E2E 테스트 가능.
