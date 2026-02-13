# Task Steps + Event-Based Continuation 설계

> Task 시스템에 구조화된 하위 단계(steps)를 추가하고,
> 에이전트 실행 종료 시 즉시 continuation을 트리거하는 메커니즘 도입.
>
> **상태**: 설계 완료, 미구현

---

## 1. 배경 및 동기

### 1.1 문제: 에이전트가 작업을 끝까지 안 함

prontolab-openclaw 에이전트가 task를 시작하지만 완료하지 않는 주요 원인:

1. **`task_complete`를 너무 빨리 호출** — 계획만 세우고 "완료" 처리
2. **`task_start`를 아예 안 함** — continuation runner가 감지할 태스크 없음
3. **progress가 비구조적** — "어디까지 했는지" 시스템이 파악 불가
4. **continuation 트리거가 느림** — 2분 폴링 + 3분 idle = 최대 5분 대기

### 1.2 목표

oh-my-opencode의 Sisyphus 패턴과 동등한 task 완료 강제 메커니즘을 OpenClaw의 기존 인프라 위에 구현한다.

| 기능 | Sisyphus (oh-my-opencode) | 목표 (prontolab-openclaw) |
|------|--------------------------|--------------------------|
| 구조화된 체크리스트 | `todowrite` | `task steps` |
| 항목별 상태 관리 | `pending → in_progress → completed` | `pending → in_progress → done` |
| 순서 변경 | 배열 전체 덮어쓰기 | `reorder_steps` |
| 즉시 감지 | `session.idle` 이벤트 | `lifecycle:end` 이벤트 |
| 재개 지연 | ~2초 (카운트다운) | ~2초 (setTimeout) |
| 파일 영구 저장 | ❌ (세션 메모리, boulder로 보완) | ✅ (task 파일에 내장) |

### 1.3 제약 조건

- 기존 task 도구 API 호환성 유지 (`task_start`, `task_update`, `task_complete` 기존 사용법 그대로 동작)
- 기존 task-continuation-runner는 폴링 기반 fallback으로 유지
- sub-agent에서는 steps 미사용 (sub-agent는 task 도구 차단됨)

---

## 2. 설계

### 2.1 TaskFile 확장

```typescript
// src/agents/tools/task-tool.ts

export interface TaskStep {
  id: string;           // 자동 생성 (s1, s2, ...)
  content: string;      // 단계 설명
  status: "pending" | "in_progress" | "done" | "skipped";
  order: number;        // 정렬 순서
}

export interface TaskFile {
  // ... 기존 필드 전부 유지 ...
  steps?: TaskStep[];   // NEW — 구조화된 하위 단계
}
```

### 2.2 Task 파일 포맷 확장

기존:
```markdown
# Task: task_xxx

## Metadata
- **Status:** in_progress
- **Priority:** high
- **Created:** 2026-02-13T12:00:00.000Z

## Description
OAuth 로그인 구현

## Progress
- Task started
- 기존 auth 구조 분석 완료

## Last Activity
2026-02-13T12:30:00.000Z
```

확장:
```markdown
# Task: task_xxx

## Metadata
- **Status:** in_progress
- **Priority:** high
- **Created:** 2026-02-13T12:00:00.000Z

## Description
OAuth 로그인 구현

## Steps
- [x] (s1) 기존 auth 구조 파악
- [>] (s2) Google OAuth strategy 추가
- [ ] (s3) GitHub OAuth callback 구현
- [ ] (s4) 통합 테스트 통과 확인

## Progress
- Task started
- [s1] 기존 auth 구조 분석 완료 — JWT 미들웨어 /src/middleware/auth.ts
- [s2] Google OAuth strategy 추가 시작

## Last Activity
2026-02-13T12:30:00.000Z
```

Steps 마커: `[x]` = done, `[>]` = in_progress, `[ ]` = pending, `[-]` = skipped

### 2.3 task_update 확장

기존 API 완전 호환 + 새로운 step 관련 action 추가:

```typescript
const TaskUpdateSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
  progress: Type.Optional(Type.String()),        // 기존: 자유 형식 로그 추가
  // NEW — step 관리
  action: Type.Optional(Type.String()),           // "add_step" | "complete_step" | "start_step" | "skip_step" | "reorder_steps" | "set_steps"
  step_content: Type.Optional(Type.String()),     // add_step 시 내용
  step_id: Type.Optional(Type.String()),          // complete_step, start_step, skip_step 시 대상
  steps_order: Type.Optional(Type.Array(Type.String())),  // reorder_steps 시 새 순서
  steps: Type.Optional(Type.Array(Type.Object({   // set_steps 시 전체 교체
    content: Type.String(),
    status: Type.Optional(Type.String()),
  }))),
});
```

#### action별 동작

**`add_step`**: 새 단계 추가
```
task_update(action: "add_step", step_content: "Token refresh 로직 추가")
```
→ steps 배열 끝에 `{id: "s5", content: "Token refresh 로직 추가", status: "pending", order: 5}` 추가

**`complete_step`**: 단계 완료 처리 + 다음 단계 자동 시작
```
task_update(action: "complete_step", step_id: "s2")
```
→ s2.status = "done", s3.status = "in_progress" (다음 pending 단계 자동 시작)
→ progress에 자동 추가: "[s2] Google OAuth strategy 추가 — 완료"

**`start_step`**: 특정 단계 시작 (순서 건너뛰기)
```
task_update(action: "start_step", step_id: "s3")
```
→ 현재 in_progress를 pending으로 되돌리고, s3.status = "in_progress"

**`skip_step`**: 단계 건너뛰기
```
task_update(action: "skip_step", step_id: "s3", progress: "GitHub OAuth는 Phase 2에서 진행")
```

**`reorder_steps`**: 순서 변경
```
task_update(action: "reorder_steps", steps_order: ["s1", "s3", "s2", "s4"])
```

**`set_steps`**: 초기 계획 설정 (task_start 직후 사용)
```
task_update(action: "set_steps", steps: [
  {content: "기존 auth 구조 파악"},
  {content: "Google OAuth strategy 추가"},
  {content: "GitHub OAuth callback 구현"},
  {content: "통합 테스트 통과 확인"}
])
```
→ 전체 steps 배열 생성 (기존 steps 덮어쓰기), 첫 번째를 자동 in_progress

**기존 `progress` 파라미터 (호환성 유지)**:
```
task_update(progress: "자유 형식 로그")
```
→ steps 무관하게 progress 배열에 추가 (기존 동작 그대로)

### 2.4 task_complete 확장

`task_complete` 호출 시 steps가 있으면 validation:
- 미완료 steps가 있으면 경고 반환 (강제 complete는 허용하되 경고)
- 모든 steps가 done/skipped이면 정상 complete

```typescript
// task_complete 처리 시
if (task.steps?.length) {
  const incomplete = task.steps.filter(s => s.status === "pending" || s.status === "in_progress");
  if (incomplete.length > 0) {
    // 경고 포함하되 complete는 허용
    return jsonResult({
      status: "completed_with_warning",
      warning: `${incomplete.length} steps still incomplete: ${incomplete.map(s => s.content).join(", ")}`,
      taskId: task.id,
    });
  }
}
```

---

## 3. Event-Based Continuation (즉시 감지)

### 3.1 현재: 폴링 기반 (task-continuation-runner.ts)

```
매 2분 → 에이전트별 검사 → in_progress task 있고 3분 idle → continuation prompt 전송
```

최대 5분 대기. 에이전트가 멈추고 5분 후에야 "계속 해" 메시지 도착.

### 3.2 목표: 이벤트 기반 (즉시 감지)

```
에이전트 실행 종료 (lifecycle:end) → 2초 대기 → incomplete steps 확인 → continuation prompt 전송
```

에이전트가 멈추고 **2초 후** "계속 해" 메시지 도착.

### 3.3 구현: `onAgentEvent` 기반 lifecycle hook

```typescript
// src/infra/task-step-continuation.ts (NEW FILE)

import { onAgentEvent, type AgentEventPayload } from "./agent-events.js";
import { resolveAgentIdFromSessionKey, isSubagentSessionKey } from "../agents/agent-scope.js";
import { findActiveTask } from "../agents/tools/task-tool.js";

const CONTINUATION_DELAY_MS = 2_000;  // 2초 대기 (grace period)
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function startTaskStepContinuation(opts: { cfg: OpenClawConfig }) {
  return onAgentEvent((evt: AgentEventPayload) => {
    // lifecycle:end 이벤트만 처리
    if (evt.stream !== "lifecycle" || evt.data.phase !== "end") return;
    if (!evt.sessionKey) return;

    // sub-agent는 제외
    if (isSubagentSessionKey(evt.sessionKey)) return;

    const agentId = resolveAgentIdFromSessionKey(evt.sessionKey);

    // 이전 타이머 취소 (새 실행이 시작되면 불필요)
    const existing = pendingTimers.get(agentId);
    if (existing) clearTimeout(existing);

    // 2초 후 체크
    pendingTimers.set(agentId, setTimeout(async () => {
      pendingTimers.delete(agentId);
      await checkAndContinue(opts.cfg, agentId);
    }, CONTINUATION_DELAY_MS));
  });
}

async function checkAndContinue(cfg: OpenClawConfig, agentId: string) {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const activeTask = await findActiveTask(workspaceDir);
  if (!activeTask) return;

  // steps가 있고 미완료 항목이 있는 경우에만 continuation
  if (!activeTask.steps?.length) return;

  const incomplete = activeTask.steps.filter(
    s => s.status === "pending" || s.status === "in_progress"
  );
  if (incomplete.length === 0) return;

  const currentStep = activeTask.steps.find(s => s.status === "in_progress");
  const prompt = formatStepContinuationPrompt(activeTask, incomplete, currentStep);

  await agentCommand({
    message: prompt,
    agentId,
    deliver: false,
  });
}
```

### 3.4 Continuation Prompt (Steps 인식)

```typescript
function formatStepContinuationPrompt(
  task: TaskFile,
  incomplete: TaskStep[],
  currentStep?: TaskStep
): string {
  const lines = [
    `[SYSTEM REMINDER - STEP CONTINUATION]`,
    ``,
    `Task "${task.description}" has incomplete steps:`,
    ``,
  ];

  for (const step of task.steps!) {
    const marker = step.status === "done" ? "✅"
      : step.status === "in_progress" ? "▶"
      : step.status === "skipped" ? "⏭"
      : "□";
    lines.push(`${marker} (${step.id}) ${step.content}`);
  }

  lines.push(``);

  if (currentStep) {
    lines.push(`Continue from: **${currentStep.content}**`);
  } else {
    lines.push(`Start the next pending step.`);
  }

  lines.push(``);
  lines.push(`Use task_update(action: "complete_step", step_id: "...") when each step is done.`);
  lines.push(`Do NOT call task_complete until all steps are done.`);

  return lines.join("\n");
}
```

### 3.5 Grace Period (2초) + 취소 조건

2초 대기 이유: 새 실행이 즉시 시작될 수 있음 (예: announce 수신 → 새 에이전트 실행).

취소 조건:
- 같은 에이전트의 새 `lifecycle:start` 이벤트 발생 → 타이머 취소
- agentQueue에 대기 중인 메시지 있음 → 스킵 (이미 다음 작업이 예정됨)

```typescript
// lifecycle:start도 감시해서 타이머 취소
if (evt.data.phase === "start") {
  const timer = pendingTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(agentId);
  }
  return;
}
```

### 3.6 아키텍처: 이중 안전망

```
[Layer 1 — 즉시] lifecycle:end → 2초 → step continuation prompt
[Layer 2 — 폴백] 2분 폴링 → 3분 idle → task continuation prompt (기존)
```

- Layer 1이 정상 동작하면 Layer 2는 도달하지 않음 (이미 재개됐으므로)
- Layer 1이 실패하면 (버그, 타이밍 문제) Layer 2가 5분 후 잡아냄
- 두 레이어 모두 동일한 `agentCommand`로 메시지 전송 → 중복 방지는 cooldown으로

### 3.7 기존 task-continuation-runner와의 관계

| 항목 | task-continuation-runner (기존) | task-step-continuation (신규) |
|------|-------------------------------|------------------------------|
| 트리거 | 2분 폴링 | lifecycle:end 이벤트 |
| 감지 속도 | 최대 5분 | 2초 |
| 감지 대상 | in_progress task 전체 | steps가 있는 task만 |
| prompt 내용 | task description + latest progress | **steps 체크리스트 + 현재 위치** |
| backlog 픽업 | ✅ | ❌ (기존 runner가 담당) |
| blocked 처리 | ✅ (unblock 요청) | ❌ (기존 runner가 담당) |
| zombie 처리 | ✅ (24시간 TTL) | ❌ (기존 runner가 담당) |

신규 모듈은 **steps 기반 즉시 continuation만 담당**. 나머지(backlog, blocked, zombie)는 기존 runner가 계속 처리.

---

## 4. 전체 플로우

### 4.1 정상 플로우 (에이전트가 한 번에 완료)

```
유저: "OAuth 구현해줘"
  │
  ▼
에이전트:
  task_start("OAuth 구현")
  task_update(action: "set_steps", steps: [
    {content: "기존 auth 구조 파악"},
    {content: "Google OAuth strategy 추가"},
    {content: "GitHub OAuth callback 구현"},
    {content: "통합 테스트 통과 확인"}
  ])
  │
  ▼
  task_update(action: "complete_step", step_id: "s1")  // 1단계 완료
  task_update(action: "complete_step", step_id: "s2")  // 2단계 완료
  task_update(action: "complete_step", step_id: "s3")  // 3단계 완료
  task_update(action: "complete_step", step_id: "s4")  // 4단계 완료
  task_complete("OAuth 로그인 구현 완료")
  │
  ▼
에이전트 실행 종료 (lifecycle:end)
  → 2초 후 체크 → steps 모두 done → continuation 불필요 → 종료
```

### 4.2 중간에 멈추는 경우 (continuation 발동)

```
유저: "OAuth 구현해줘"
  │
  ▼
에이전트:
  task_start("OAuth 구현")
  task_update(action: "set_steps", steps: [...4개...])
  task_update(action: "complete_step", step_id: "s1")
  task_update(action: "complete_step", step_id: "s2")
  │
  ▼
에이전트 실행 종료 (lifecycle:end) ← 여기서 멈춤!
  │
  ▼
2초 후 task-step-continuation 발동:
  "[SYSTEM REMINDER - STEP CONTINUATION]
   Task 'OAuth 구현' has incomplete steps:
   ✅ (s1) 기존 auth 구조 파악
   ✅ (s2) Google OAuth strategy 추가
   ▶ (s3) GitHub OAuth callback 구현
   □ (s4) 통합 테스트 통과 확인
   Continue from: GitHub OAuth callback 구현"
  │
  ▼
에이전트 재개: s3, s4 진행 → task_complete
```

### 4.3 중간에 계획 수정 (동적 단계 추가/순서 변경)

```
에이전트가 s2 진행 중 새로운 요구사항 발견:
  task_update(action: "add_step", step_content: "Token refresh 로직 추가")
  task_update(action: "reorder_steps", steps_order: ["s1", "s2", "s5", "s3", "s4"])
  │
  ▼
Steps:
  ✅ (s1) 기존 auth 구조 파악
  ▶ (s2) Google OAuth strategy 추가
  □ (s5) Token refresh 로직 추가    ← 새로 추가, 순서 변경
  □ (s3) GitHub OAuth callback 구현
  □ (s4) 통합 테스트 통과 확인
```

### 4.4 Sub-agent 위임 + Steps 연동

```
에이전트:
  task_start("OAuth 구현")
  task_update(action: "set_steps", steps: [...])
  task_update(action: "start_step", step_id: "s1")
  │
  ▼
  sessions_spawn(agentId: "explorer", task: "auth 구조 파악...", label: "explore-auth")
  │
  ▼
에이전트 실행 종료 (lifecycle:end)
  → 2초 후 체크 → s1 = in_progress → 하지만 sub-agent가 실행 중
  → sub-agent 실행 중이면 스킵 (queue 체크)
  │
  ▼
Explorer 완료 → announce 도착 → 에이전트 재개
  → task_update(action: "complete_step", step_id: "s1")
  → task_update(action: "start_step", step_id: "s2")
  → sessions_spawn(agentId: "worker-deep", task: "Google OAuth 구현...", label: "impl-oauth")
  │
  ▼
Worker-deep 완료 → announce → 에이전트 재개 → ... 반복
```

---

## 5. 수정 대상 파일

| 파일 | 변경 내용 | 규모 |
|------|----------|------|
| `src/agents/tools/task-tool.ts` | TaskStep 타입 추가, TaskFile에 steps 필드 추가, task_update에 step action 처리, task_complete에 steps validation, 파일 직렬화/역직렬화에 Steps 섹션 추가 | 중 |
| `src/infra/task-step-continuation.ts` | **신규 파일** — lifecycle:end 이벤트 기반 즉시 continuation | 소 |
| `src/infra/task-continuation-runner.ts` | formatContinuationPrompt에 steps 체크리스트 포함 | 소 |
| `src/gateway/server.impl.ts` | startTaskStepContinuation() 호출 추가 | 소 |
| `src/gateway/server-close.ts` | stopTaskStepContinuation() 호출 추가 | 소 |
| 각 에이전트 AGENTS.md (11개) | steps 사용 가이드라인 추가 | 소 |

### 코드 변경 예상 규모

- 신규 코드: ~200줄 (task-step-continuation.ts)
- 수정 코드: ~150줄 (task-tool.ts steps 처리)
- 수정 코드: ~30줄 (continuation-runner prompt 수정)
- 수정 코드: ~10줄 (server.impl.ts, server-close.ts)
- **총 ~400줄**

---

## 6. AGENTS.md 추가 지침

### 6.1 Steps 사용 가이드

```markdown
### Task Steps (구조화된 작업 단계)

복잡한 작업(3단계 이상)은 반드시 steps를 설정하라:

task_start("기능 구현")
task_update(action: "set_steps", steps: [
  {content: "현재 코드 분석"},
  {content: "구현"},
  {content: "테스트 작성"},
  {content: "빌드 확인"}
])

각 단계 완료 시:
task_update(action: "complete_step", step_id: "s1")

새 단계 발견 시:
task_update(action: "add_step", step_content: "새로 필요한 작업")

task_complete()는 모든 steps가 done/skipped일 때만 호출하라.
steps가 남아있는데 task_complete를 호출하면 안 된다.
```

### 6.2 멈추지 마 규칙

```markdown
### 연속 실행 규칙

모든 steps가 완료될 때까지 연속으로 작업하라.
중간에 멈추면 시스템이 자동으로 재개 프롬프트를 보낸다.
멈출 필요가 없다면 멈추지 마라.
```

---

## 7. 기존 기능과의 호환성

| 기존 기능 | 영향 |
|----------|------|
| `task_update(progress: "...")` | ✅ 그대로 동작 (steps와 무관) |
| `task_start` / `task_complete` | ✅ steps 없이도 기존 방식 동작 |
| `task_block` / `task_resume` | ✅ steps와 독립적 동작 |
| `task_list` / `task_status` | ✅ steps 정보 추가 표시 |
| task-continuation-runner | ✅ 기존 폴링 유지 + steps 체크리스트 추가 |
| sub-agent task 도구 차단 | ✅ 무관 (sub-agent는 task 도구 미사용) |
| Task Monitor API | ⚠️ steps 필드 추가 시 API 응답 확장 필요 |

---

## 8. 테스트 계획

### Unit Tests

| 테스트 | 대상 |
|--------|------|
| set_steps로 steps 초기화 | task-tool.ts |
| complete_step 시 다음 step 자동 시작 | task-tool.ts |
| add_step / skip_step / reorder_steps | task-tool.ts |
| Steps 섹션 직렬화/역직렬화 | task-tool.ts |
| task_complete + 미완료 steps 경고 | task-tool.ts |
| lifecycle:end → 2초 후 continuation 발동 | task-step-continuation.ts |
| lifecycle:start → 타이머 취소 | task-step-continuation.ts |
| sub-agent 실행 중 → 스킵 | task-step-continuation.ts |

### Integration Tests (Discord)

1. 에이전트에게 복잡한 작업 요청 → steps 설정 확인
2. 에이전트가 중간에 멈춤 → 2초 후 자동 재개 확인
3. 에이전트가 steps 동적 추가/순서 변경 → 파일에 반영 확인
4. 모든 steps 완료 → task_complete → continuation 미발동 확인
5. Sub-agent 실행 중 → continuation 스킵 → announce 후 재개 확인

---

## 9. 실행 순서

```
[Phase 1 — 코드 변경]
  1. TaskStep 타입 + TaskFile.steps 필드 추가
  2. task_update에 step action 처리 로직 추가
  3. Task 파일 직렬화/역직렬화에 Steps 섹션 추가
  4. task_complete에 steps validation 추가
  5. task_status/task_list에 steps 표시 추가

[Phase 2 — Event-based Continuation]
  6. task-step-continuation.ts 신규 파일 생성
  7. server.impl.ts에서 start/stop 호출 추가
  8. task-continuation-runner.ts의 prompt에 steps 체크리스트 추가

[Phase 3 — AGENTS.md 업데이트]
  9. 부모 에이전트 AGENTS.md에 steps 사용 가이드 추가
  10. "멈추지 마" + Definition of Done 규칙 추가

[Phase 4 — 테스트]
  11. Unit tests 작성
  12. 빌드 확인 (tsc --noEmit)
  13. Discord 통합 테스트

[Phase 5 — 배포]
  14. pnpm build && npm link
  15. Gateway restart
  16. 모니터링
```

---

_원본 분석: Sisyphus todo-continuation-enforcer.ts + OpenClaw task-continuation-runner.ts + agent-events.ts 비교 분석_
_작성일: 2026-02-13_
