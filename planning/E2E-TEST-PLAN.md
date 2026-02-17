# E2E 테스트 결과 — A2A 비동기 통신 시스템

> 실행일: 2026-02-18
> 대상: prontolab-openclaw + task-hub + task-monitor
> 결과: **28/28 PASS** (2개 버그 발견 → 즉시 수정)

## 테스트 환경

| 서비스               | 포트                            | 상태                       |
| -------------------- | ------------------------------- | -------------------------- |
| OpenClaw Gateway     | 18789                           | PID 18162 → SIGUSR1 재시작 |
| Task-Monitor (Bun)   | 3847                            | 로컬 + Docker (tunnel-net) |
| Task-Hub (Next.js)   | 3102                            | Docker (healthy)           |
| MongoDB (todo-mongo) | 27018 (호스트) / 27017 (Docker) | 824+ events                |

## 테스트 결과 요약

| #        | 카테고리                                | 테스트 수 | Pass   | 상태 | 비고                                |
| -------- | --------------------------------------- | --------- | ------ | ---- | ----------------------------------- |
| T01      | Design #1: Parallel A2A                 | 3         | 3      | ✅   | nested lane=8, 병렬 전송 확인       |
| T02      | Design #2-1: EventCache + WS            | 3         | 3      | ✅   | 100+ events, a2a 이벤트 확인        |
| T03      | Design #2-2: MongoDB Sync + Search      | 4         | 4      | ✅   | **버그 수정: .toSorted→.sort**      |
| T04      | Design #3: Error Classification + Retry | 3         | 3      | ✅   | forbidden 에러, retry 코드 확인     |
| T05      | Design #4: Ping-pong Optimization       | 3         | 3      | ✅   | 32개 단위테스트 전부 통과           |
| T06      | Gap #1: A2A Session Reaper              | 2         | 2      | ✅   | 26개 단위테스트, 크론 통합 확인     |
| T07      | Gap #2: Config Schema                   | 2         | 2      | ✅   | Zod 스키마 검증, 범위 제한 확인     |
| T08      | Gap #3: Task-Hub SSE Bridge             | 2         | 2      | ✅   | SSE connected 이벤트 수신           |
| T09      | Gap #4: AgentStepResult                 | 2         | 2      | ✅   | reply/ok/error 구조 확인            |
| T10      | Gap #5: Unit Tests                      | 1         | 1      | ✅   | **버그 수정: mock→AgentStepResult** |
| T11      | Gap #6: MongoDB + Search UI             | 3         | 3      | ✅   | 10개 인덱스, 0 중복, 페이지 접근    |
| **합계** |                                         | **28**    | **28** | ✅   |                                     |

---

## 발견 및 수정된 버그

### Bug #1: A2A 테스트 mock이 string 반환 (AgentStepResult 필요)

- **파일**: `src/agents/tools/sessions-send-tool.a2a.test.ts`
- **증상**: 3개 테스트 실패 — mock이 string을 반환하지만 코드는 `{ reply, ok }` 객체 기대
- **원인**: Design #4 구현 시 `runAgentStep` 반환값이 string → `AgentStepResult`로 변경됐지만 테스트 mock 미업데이트
- **수정**: 모든 mock을 `{ reply: "...", ok: true }` 형태로 변경
- **영향**: 테스트 14/14 통과

### Bug #2: MongoDB Cursor에서 `.toSorted()` 사용 (`.sort()` 필요)

- **파일**: `scripts/task-monitor-server.ts` (라인 1965, 2013)
- **증상**: 검색 API가 "MongoDB not available" 반환
- **원인**: MongoDB Cursor는 `.toSorted()` 미지원 (Array 메서드), `.sort()` 사용 필요
- **수정**: 2곳에서 `.toSorted({ ... })` → `.sort({ ... })` 변경
- **영향**: 검색 API 정상 동작 (120개 a2a 이벤트 검색 성공)

---

## 상세 테스트 결과

### T01: Design #1 — Parallel A2A Execution ✅

**T01-1: Nested Lane Concurrency** ✅

- `DEFAULT_NESTED_MAX_CONCURRENT = 8`
- `applyGatewayLaneConcurrency` → `setCommandLaneConcurrency(CommandLane.Nested, 8)`

**T01-2: 단일 A2A 전송** ✅

```json
{
  "status": "ok",
  "sessionKey": "agent:eden:main",
  "conversationId": "8f02922b-24b6-436d-a5fd-b68852528403"
}
```

**T01-3: 병렬 A2A 전송** ✅

- ruda→eden + ruda→seum 동시 발송
- 두 요청 모두 ~5초에 동시 타임아웃 (순차였다면 하나는 10초+)

### T02: Design #2 Phase 1 — EventCache + WS ✅

**T02-1: EventCache 조회** ✅

- `/api/events` → 100개 이벤트 반환

**T02-2: WebSocket Push** ✅

- WS 클라이언트 1개 연결 확인 (task-monitor 로그)

**T02-3: A2A 이벤트 타입** ✅

- `a2a.send`, `a2a.response`, `a2a.complete` 이벤트 확인

### T03: Design #2 Phase 2 — MongoDB Sync + Search ✅

**T03-1: MongoDB 연결** ✅

- "[MongoDB] Connected" + "Full sync: 822 events"

**T03-2: 이벤트 동기화** ✅

- `coordination_events`: 824개
- `work_sessions`: 108개

**T03-3: 이벤트 검색 API** ✅

- `GET /api/events/search?q=a2a` → 120개 결과 (50개 반환, total: 120)

**T03-4: Work Session 검색** ✅

- `GET /api/work-sessions/search?q=ruda` → 15개 결과

### T04: Design #3 — Error Classification + Retry ✅

**T04-1: 에러 분류** ✅

- 존재하지 않는 에이전트 → `status: "forbidden"` + 정책 에러 메시지

**T04-2: 타임아웃** ✅

- 5초 타임아웃 → `status: "timeout"`

**T04-3: Retry 이벤트** ✅

- `A2A_RETRY` 이벤트 타입 정의 + emit 코드 확인
- 24개 단위테스트 통과 (error classification + backoff)

### T05: Design #4 — Ping-pong Optimization ✅

**T05-1: Intent Classification** ✅

- 32개 단위테스트 전부 통과
- notification/question/collaboration/escalation/result_report 분류

**T05-2: maxPingPongTurns** ✅

- Zod 스키마: `z.number().int().min(0).max(10)`

**T05-3: Early Termination** ✅

- 반복 감지 (Jaccard similarity > 0.85)
- 최소 내용 (< 20자)
- 결론 신호 패턴

### T06-T09: Gaps ✅

**T06: Session Reaper** ✅ (26개 단위테스트, 크론 통합)
**T07: Config Schema** ✅ (Zod 스키마, maxPingPongTurns/retry/timeout)
**T08: SSE Bridge** ✅ (`data: {"type":"connected"}` 수신)
**T09: AgentStepResult** ✅ (`{ reply, ok, error: { code, message, waitStatus } }`)

### T10: Unit Tests ✅

- 전체: 7336 pass (3개 수정 후)
- A2A 관련: 82개 (14 + 24 + 32 + 12)

### T11: MongoDB + Search UI ✅

**T11-1: 인덱스** ✅ — 10개 인덱스 (ts, type+ts, agentId+ts, conversationId+ts, workSessionId+ts, eventRole+ts, collabCategory+ts, eventHash unique, createdAt TTL)
**T11-2: 중복 방지** ✅ — 824 events, 824 unique hashes, 0 duplicates
**T11-3: Conversations 페이지** ✅ — HTTP 307 (로그인 리다이렉트)

---

## Docker Compose 변경사항

`todo-mongo` 컨테이너에 호스트 포트 매핑 추가:

```yaml
todo-mongo:
  ports:
    - "27018:27017"
```

- 호스트에서 `mongodb://localhost:27018/task_monitor`로 접근 가능
- 기존 `mongodb` 컨테이너 (호스트 27017, 인증 필요)와 충돌 방지
