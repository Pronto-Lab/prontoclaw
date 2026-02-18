# Task-Hub Agent Collaboration Hub (Phase 9)

> 작성일: 2026-02-18
> 상태: ✅ 구현 완료
> 대상: `task-hub`, `prontolab-openclaw` (에이전트 프롬프트)

## 0. 배경

Task-Hub를 에이전트 협업의 중심 허브로 전환. Discord는 알림/보고 전용으로 축소하고, 대화 검색, 에이전트 지시, 대화 개입, 의사결정 요약을 웹에서 수행.

## 1. 구현된 기능

### 1.1 에이전트 메시지 전송

Task-Hub UI에서 에이전트에게 직접 메시지를 보내는 기능.

**흐름:**

```
브라우저 → POST /api/agent/send → Gateway /tools/invoke (sessions_send) → 에이전트
```

**파일:**

- `src/app/api/agent/send/route.ts` — POST 핸들러, 유효성 검사, sendToAgent 호출
- `src/lib/gateway.ts` — `sendToAgent()` 함수 (sessionKey: `agent:{id}:main`)

**제약:**

- 허용 에이전트: ruda, eden, seum, dajim, yunseul, miri, onsae, ieum, nuri, hangyeol, grim
- 메시지 최대 10,000자
- 타임아웃 기본 60초

### 1.2 팀 메시징 (동시 전송)

팀 전원에게 동일 메시지를 병렬 전송. 각 에이전트가 팀 컨텍스트를 받아 A2A로 협업.

**흐름:**

```
브라우저 → POST /api/team/send → Promise.allSettled(sendToAgent × N) → 에이전트 전원
```

**팀 정의:**
| 팀 | 리드 | 멤버 | 역할 |
|----|------|------|------|
| 개발팀 (dev) | 이든 | 이든, 세움, 다짐 | 개발, 인프라, QA |

**메시지 포맷 (각 에이전트가 받는 내용):**

```
[팀 작업 - 개발팀]
팀원: 이든(개발/리드), 세움(인프라), 다짐(QA)

{사용자 메시지}

---
이 메시지는 개발팀 전원에게 동시 전송되었습니다.
다른 팀원과 sessions_send로 A2A 협업하여 작업을 진행하세요.
```

**파일:**

- `src/app/api/team/send/route.ts` — 병렬 전송, 팀 메시지 포맷팅
- `src/lib/conversations/constants.ts` — `TEAMS`, `TEAM_LIST` 정의

**팀 추가 방법:** `constants.ts`의 `TEAMS` 객체에 새 팀 추가.

### 1.3 대화 개입 (Human Intervention)

활성 A2A 대화에 사람이 개입하여 방향을 조정.

**동작:**

1. 활성 대화 선택 시 InterventionBanner 표시
2. 메시지 전송 시 `[Human Intervention]` 접두사 자동 추가
3. 에이전트는 해당 접두사를 감지하고 즉시 human 지시를 최우선 처리
4. UI에서 human 메시지는 amber/gold 버블로 표시

**에이전트 프롬프트 규칙 (11개 에이전트 AGENTS.md에 추가됨):**

```markdown
## Human Intervention Rule (CRITICAL)

A2A 대화 중 `[Human Intervention]`으로 시작하는 메시지를 받으면:

1. 즉시 현재 작업을 멈추고 human 지시를 최우선으로 처리
2. 상대 에이전트에게 "인간 관리자가 방향을 조정했다"는 사실을 전달
3. human 지시에 따라 대화 방향을 조정
4. 조정된 방향으로 A2A 대화를 계속 진행
```

**파일:**

- `src/lib/conversations/constants.ts` — `HUMAN_INTERVENTION_PREFIX`, `AGENT_DISPLAY["human"]`
- `src/app/conversations/page.tsx` — InterventionBanner, ChatBubble human 스타일링
- `~/.openclaw/workspace-{agent}/AGENTS.md` × 11 — Human Intervention Rule

### 1.4 AI 의사결정 요약

Anthropic Claude를 활용한 스트리밍 대화 요약 생성.

**흐름:**

```
브라우저 → POST /api/conversations/summarize
  → Task-Monitor /api/work-sessions/{id} (대화 데이터 조회)
  → eventsToTranscript() (이벤트 → 텍스트 변환)
  → Anthropic streaming API (claude-sonnet-4-20250514)
  → SSE 응답 → 브라우저 실시간 렌더링
```

**요약 형식:**

- `detailed`: 참여자, 기간, 주요 의사결정, 실행 항목, 미결 사항, 다음 단계
- `brief`: 3-5문장 핵심 요약

**파일:**

- `src/app/api/conversations/summarize/route.ts` — SSE 스트리밍 응답
- `src/lib/anthropic.ts` — `streamSummary()`, `eventsToTranscript()`, 요약 시스템 프롬프트

## 2. UI 변경사항

`src/app/conversations/page.tsx` (921줄 → 1380줄)

### 추가된 컴포넌트

| 컴포넌트           | 위치                     | 설명                                          |
| ------------------ | ------------------------ | --------------------------------------------- |
| MessageInput       | ChatView 하단            | 에이전트/팀 모드 토글, 대상 선택, 메시지 입력 |
| InterventionBanner | ChatView 헤더 아래       | 활성 대화 개입 경고                           |
| SummaryPanel       | 오른쪽 슬라이딩 오버레이 | AI 요약 스트리밍 표시                         |

### MessageInput 모드

```
[이든] [세움] | [💻 개발팀(3)]   ⚡ 개입 모드 / 👥 팀 전송
[textarea                      ] [전송]
```

- 에이전트 버튼 클릭 → 에이전트 모드 (개별 전송)
- 팀 버튼 클릭 → 팀 모드 (전원 동시 전송)
- 활성 대화에서 에이전트 모드 → 자동 개입 모드 (amber 전송 버튼)

### ChatBubble 스타일링

| 발신자             | 스타일                               |
| ------------------ | ------------------------------------ |
| 왼쪽 에이전트      | 흰색 배경, 회색 테두리               |
| 오른쪽 에이전트    | emerald 그라데이션                   |
| Human Intervention | amber/orange 그라데이션, ring-2 강조 |

## 3. API 엔드포인트

| Method | Path                           | 인증   | 설명                                             |
| ------ | ------------------------------ | ------ | ------------------------------------------------ |
| POST   | `/api/agent/send`              | Cookie | 개별 에이전트에게 메시지 전송                    |
| POST   | `/api/team/send`               | Cookie | 팀 전원에게 동시 전송                            |
| POST   | `/api/conversations/summarize` | Cookie | AI 요약 SSE 스트리밍                             |
| POST   | `/api/proxy/[...path]`         | Cookie | Task-Monitor POST 프록시 (기존 GET/PATCH에 추가) |

## 4. 환경 변수 (docker-compose.yml)

| 변수                | 용도                               |
| ------------------- | ---------------------------------- |
| `GATEWAY_URL`       | Gateway 엔드포인트 (sessions_send) |
| `GATEWAY_TOKEN`     | Gateway Bearer 인증                |
| `ANTHROPIC_API_KEY` | AI 요약 생성                       |
| `TASK_MONITOR_URL`  | 대화 데이터 조회                   |

## 5. 커밋 이력

| 커밋      | 설명                                                           |
| --------- | -------------------------------------------------------------- |
| `2ff32ac` | Phase 9 핵심 구현 (agent send, human intervention, AI summary) |
| `2f50393` | 팀 메시징 (동시 전송, 팀 모드 UI)                              |
