# Work Session 기반 3인+ 협업 설계

> 작성일: 2026-02-16
> 상태: 설계 확정 전 (Design Ready)
> 대상: `prontolab-openclaw` + `task-hub`

## 1. 문제 정의

현재 협업 가시화는 `conversationId` 중심(주로 1:1 thread)으로 동작한다.
2인 협업은 보이지만, 3인 이상 fan-out/fan-in 협업에서는 다음 문제가 발생한다.

- 동일 작업인데 thread가 시간 기준으로 분리되어 "한 작업"으로 보이지 않음
- `Conversations` 목록이 구조(누가 누구를 spawn했는지)보다 시간 순서 중심으로만 보임
- `Tasks`와 `Conversations`가 약하게 연결되어 작업 추적이 끊김
- 하위 run 완료 후 피드백 재작업이 들어오면 같은 협업 흐름으로 이어지기 어려움

## 2. 목표 / 비목표

### 2.1 목표

- 협업 루트 식별자 `workSessionId` 도입
- 3인 이상 협업을 하나의 작업 세션으로 자연스럽게 묶기
- UI를 "트리(구조) + 타임라인(시간)" 이중 뷰로 정리
- 하위 run 완료 후 피드백 재작업도 같은 흐름에서 재개
- 기존 이벤트/로그/테스트/운영 체계와 역호환 유지

### 2.2 비목표

- 기존 이벤트 타입 전면 교체
- task 파일 포맷의 파괴적 변경
- 과거 로그 전체 재작성(backfill)

## 3. 확정된 의사결정

1. 루트 키: `workSessionId`
2. 생성 기준: `task_start` 우선, 없으면 첫 `sessions_spawn`에서 fallback 생성
3. UI 기본: 트리 우선 + 상세 타임라인
4. 세션 상태 모델:
   - `ACTIVE`: 하위 run 진행 중
   - `QUIET`: 하위 run 전부 완료(즉시 진입)
   - `ARCHIVED`: 24시간 무활동
5. 재작업 모델:
   - `QUIET` 중 활동 발생 시 같은 `workSessionId`를 `ACTIVE`로 복귀

## 4. 현재 시스템 분석 (연동 관점)

### 4.1 OpenClaw (이미 반영된 기반)

- `sessions_spawn`에서 `a2a.spawn`, `a2a.send`, `a2a.spawn_result` 발행
- `subagent-announce`에서 `a2a.response`, `a2a.complete` 발행
- `conversationId`는 spawn 시 생성되어 response/complete까지 전파
- `task-continuation-runner`는 team-state 경로 정합성 보정됨
- `task-monitor-server`는 `/api/events` 제공 + `continuation_event`, `task_step_update` 브로드캐스트

### 4.2 Task-Hub (현재 UI 동작)

- `Conversations`는 `/api/proxy/events?limit=500` 기반
- 1차 그룹: `conversationId` (없으면 agent pair + 시간 근접)
- 2차 그룹: 시간 임계값(2분) 세션
- 제목은 message/label 파싱으로 요약

### 4.3 현재 한계

- 상위 루트(`workSessionId`) 부재로 멀티-스레드 협업 묶음이 불안정
- 시간 임계값 기반 그룹핑은 활동 간격이 길면 세션이 분리됨
- 이벤트 500개 제한 시 장기 협업의 상태 계산 오차 가능

## 5. 목표 아키텍처

```text
Task (taskId)
  -> Work Session (workSessionId)
       -> Conversations (conversationId, N개)
            -> Events (a2a/continuation/plan/...)
```

핵심 원칙:

- `workSessionId`는 "협업 작업 전체"를 대표
- `conversationId`는 "에이전트 간 대화 스레드" 단위
- 모든 협업 이벤트는 가능하면 `workSessionId`를 포함

## 6. 데이터 모델

### 6.1 이벤트 공통 확장 필드

`event.data`에 다음 필드를 추가한다.

- `workSessionId: string`
- `rootTaskId?: string`
- `parentConversationId?: string`
- `parentRunId?: string`
- `depth?: number` (루트=0)
- `hop?: number` (메시지 hop)
- `previousWorkSessionId?: string` (archive 후 새 세션 재개 연결용)

### 6.2 필드 의미

- `workSessionId`: 협업 루트 ID (필수 목표)
- `rootTaskId`: `task_start`로 생성된 루트 task ID
- `parentConversationId`: spawn한 상위 conversation
- `parentRunId`: spawn parent run
- `depth`: 협업 트리 깊이
- `previousWorkSessionId`: 오래된 세션과 후속 세션 연결

### 6.3 Task 파일 확장 (비파괴)

`TaskFile` 메모리 모델에 선택 필드 추가:

- `workSessionId?: string`
- `previousWorkSessionId?: string`

`formatTaskFileMd`/`parseTaskFileMd`의 `## Metadata`에 선택적으로 직렬화:

- `- **Work Session:** <id>`
- `- **Previous Work Session:** <id>`

기존 파서는 미인지 필드를 무시하므로 역호환 유지.

### 6.4 Subagent Registry 확장

`SubagentRunRecord`에 이미 있는 `conversationId`와 함께:

- `workSessionId?: string`
- `rootTaskId?: string`
- `parentConversationId?: string`
- `depth?: number`

## 7. ID 생성/전파 규칙

### 7.1 생성 규칙

1. `task_start` 호출 시:
   - `workSessionId = ws_<uuid>` 생성
   - task 메타데이터에 저장

2. `sessions_spawn` 호출 시:
   - 우선순위로 `workSessionId` 해석

```text
explicit arg
 -> runtime inherited context
 -> current active task(workSessionId)
 -> create fallback ws_<uuid>
```

3. `task_start` 없는 협업의 fallback:
   - 첫 `a2a.spawn` 시 생성
   - `rootTaskId`는 비어도 허용

### 7.2 전파 규칙

- spawn 이벤트에서 생성/해석된 `workSessionId`를
  - `a2a.spawn`
  - `a2a.send`
  - `a2a.spawn_result`
  - `a2a.response`
  - `a2a.complete`
  - `continuation.*`, `plan.*`, `unblock.*`, `zombie.*`
  에 전파

- child가 다시 spawn할 때:
  - 부모 `workSessionId` 계승
  - `depth = parent.depth + 1`

## 8. 상태머신

```text
            (all child runs completed)
ACTIVE  ---------------------------------> QUIET
  ^                                          |
  | (new event / respawn / feedback)        | (24h inactivity)
  +------------------------------------------+
                     ARCHIVED
```

- `QUIET` 진입: 즉시 (하위 run 전부 완료 시)
- `ARCHIVED` 전환: `lastActivity + 24h`
- `ARCHIVED` 이후 재작업:
  - 기본 권장: 새 `workSessionId` 생성
  - 단, `previousWorkSessionId`로 연결 그래프 유지

## 9. UI 설계 (Task-Hub Conversations)

### 9.1 목록 구조

현재:

```text
Session(time-bucket)
  -> Thread(conversationId)
```

목표:

```text
Work Session(workSessionId)
  -> Conversation Thread(conversationId)
     -> Messages/Events
```

### 9.2 기본 화면

- 좌측: Work Session 리스트 (상태 배지: ACTIVE/QUIET/ARCHIVED)
- 중간: 선택 Work Session의 협업 트리
- 우측: 선택 thread/event 타임라인

### 9.3 제목/요약 생성 우선순위

- 1순위: `label`
- 2순위: `[Goal] ...`
- 3순위: 첫 user-facing message/replyPreview
- 4순위: `협업 작업`

### 9.4 3인+ 협업 표시 예시

```text
WS-4f2a (ACTIVE)
└─ ruda
   ├─ conv-a: ruda -> eden
   │  └─ conv-a1: eden -> worker-quick
   └─ conv-b: ruda -> seum
      └─ conv-b1: seum -> consultant
```

## 10. API / 백엔드 설계

### 10.1 Task Monitor API 확장

기존 유지:

- `GET /api/events?limit=...&since=...`

추가 권장:

- `GET /api/events?workSessionId=<id>`
- `GET /api/work-sessions?status=ACTIVE|QUIET|ARCHIVED&limit=...`
- `GET /api/work-sessions/:id` (요약 + thread index)

주의:

- 초기에 `Conversations`는 기존 `/api/events` 기반 유지 가능
- 이후 성능 이슈 시 `/api/work-sessions`로 점진 이전

### 10.2 성능/일관성

- 이벤트 로그 append-only 유지 (`coordination-events.ndjson`)
- 서버에서 work-session 집계를 캐시(예: 5초 TTL)
- 클라이언트는 폴링 + WS 혼합 유지

## 11. 기존 시스템 연동 검토

### 11.1 task tool 연동

- `task_start`에서 `workSessionId` 생성/저장
- `task_update/task_complete/task_block/...` emit 데이터에 `workSessionId` 포함

영향:

- task 파일 파서 확장 필요
- 기존 task 동작과 충돌 없음(선택 필드)

### 11.2 sessions_spawn / subagent_registry / announce 연동

- spawn 시점 해석된 `workSessionId`를 registry까지 저장
- announce 단계에서 response/complete에 동일 값 보장

영향:

- 현재 구조(`conversationId` 전파)와 동일 패턴이라 변경 난이도 낮음

### 11.3 continuation runner 연동

- `continuation.*` 이벤트 발행 시 관련 task의 `workSessionId` attach

영향:

- task를 찾을 수 없는 경우 null 허용 + fallback 그룹

### 11.4 Task-Hub Conversations 연동

- 기존 conversationId thread 그룹은 유지
- 상위 그룹만 `workSessionId`로 교체
- 구버전 이벤트(필드 없음)는 기존 시간 버킷 fallback

## 12. 리스크 및 완화

| 리스크 | 설명 | 완화책 |
| --- | --- | --- |
| task 미연결 spawn | `task_start` 없이 spawn 시작 | fallback 생성 허용 + 이후 첫 task와 soft-link |
| 다중 active task 모호성 | spawn이 어느 task 소속인지 불명확 | `sessions_spawn`에 `taskId` optional 추가(권장), 없으면 CURRENT_TASK 사용 |
| 로그 길이 제한 | `limit=500`로 상태 오판 | server-side 집계 endpoint 추가, pagination 도입 |
| 중복 이벤트 | retry/재시도 시 중복 | runId + type + seq dedupe 키 적용 |
| ARCHIVED 재개 UX 혼선 | 옛 세션 재사용 vs 신규 세션 충돌 | 기본 신규 생성 + `previousWorkSessionId` 링크 표시 |
| 회귀 리스크 | 기존 대화 화면 깨짐 | 역호환 파서 + fallback grouping 유지 |

## 13. 테스트 전략

### 13.1 단위 테스트

- `sessions-spawn-tool`: `workSessionId` 생성/계승/전파
- `subagent-announce`: response/complete 전파 검증
- `task-tool`: task metadata 파싱/직렬화
- `continuation-runner`: continuation 이벤트에 workSession attach

### 13.2 통합 테스트

- fan-out(1->3) + fan-in 응답 정렬
- 2단계 spawn(depth>1) 트리 연결
- QUIET -> ACTIVE 재개
- 24h 무활동 -> ARCHIVED 전환

### 13.3 E2E (Task-Hub)

- `workSessionId` 1개에 여러 conversation thread가 묶여 표시
- 리스트 제목이 작업 요약 1줄로 표시
- 트리와 타임라인이 동일 데이터 소스를 가리킴
- 구버전 이벤트도 fallback으로 목록 표시

## 14. 단계별 구현 계획

### Phase A - 데이터 계층

- 이벤트 데이터 필드 확장 (`workSessionId` 등)
- task metadata 필드 추가
- spawn/announce/continuation 전파

### Phase B - 집계 계층

- task-monitor의 work-session 집계 endpoint 추가
- 상태 계산(ACTIVE/QUIET/ARCHIVED) 구현

### Phase C - UI 계층

- Conversations 상위 그룹을 workSession 기반으로 전환
- 트리 패널 추가, thread/detail 유지

### Phase D - 운영 안정화

- 메트릭/로그 대시보드 보강
- 보관 정책 및 정리 스크립트

## 15. 운영/관측 포인트

- `workSession.active.count`
- `workSession.quiet.count`
- `workSession.archived.count`
- `workSession.reactivated.count`
- `workSession.fallback.created.count`
- `workSession.crossAgent.depth.max`

알람 권장:

- fallback 생성 비율 급증
- ACTIVE 세션 평균 체류시간 급증
- `a2a.spawn_result.status=error` 비율 급증

## 16. 수용 기준 (Definition of Done)

- 3인 이상 협업이 단일 `workSessionId`로 안정적으로 묶인다.
- 하위 run 완료 후 피드백 재작업이 동일 세션에서 자연스럽게 재개된다.
- `Conversations`에서 구조(트리)와 시간(타임라인)을 모두 확인 가능하다.
- 기존 이벤트만 가진 과거 데이터도 깨지지 않고 fallback 렌더링된다.
- 추가 테스트(단위/통합/E2E)가 모두 통과한다.

## 17. 구현 전 체크리스트

- [ ] `sessions_spawn`에 `taskId` optional 파라미터 추가 여부 확정
- [ ] `ARCHIVED` 이후 재작업 정책 최종 확정 (신규 생성 + 링크 유지 권장)
- [ ] `/api/work-sessions` endpoint 도입 시점 확정 (Phase B 즉시 vs 후속)
- [ ] 이벤트 보관(30일 롤링) 운영 정책 확정

