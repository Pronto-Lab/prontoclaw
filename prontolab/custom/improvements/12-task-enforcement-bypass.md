# Task Enforcement Bypass (태스크 강제 실행 우회)

> 작성일: 2026-02-19
> 상태: 설계 문서 (구현 전)
> 우선순위: 🔴 높음 (High)
> 노력 추정: M (0.5~1일)
> 대상: `prontolab-openclaw` — `src/plugins/core-hooks/task-enforcer.ts`, `src/agents/system-prompt.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`

---

## 1. 문제 정의

### 1.1 3계층 강제 실행 시스템

시스템은 에이전트가 `task_start` 없이 작업 도구를 사용하지 못하도록 **3개의 독립적인 계층**으로 구성된 강제 실행 시스템을 갖추고 있다:

| 계층 | 위치 | 유형 | 역할 |
|------|------|------|------|
| **1. 시스템 프롬프트** | `src/agents/system-prompt.ts:440-451` | Soft (지시) | "⚠️ HARD RULE: task_start mandatory" 텍스트 포함 |
| **2. Task Enforcer 훅** | `src/plugins/core-hooks/task-enforcer.ts` | Hard (차단) | `before_tool_call` 훅으로 `write`, `edit`, `bash`, `exec` 차단 |
| **3. 도구 정책** | `src/agents/pi-tools.policy.ts` | Structural (구조적) | 서브에이전트에게 `task_*` 도구 자체를 거부 |

이 3계층은 서로 보완적으로 설계되었지만, **각 계층에 독립적인 우회 경로**가 존재한다.

### 1.2 promptMode 결정 로직

```typescript
// pi-embedded-runner/run/attempt.ts:426-431
const promptMode =
  isSubagentSessionKey(params.sessionKey) ||
  isCronSessionKey(params.sessionKey) ||
  isA2ASessionKey(params.sessionKey)
    ? "minimal"
    : "full";
```

세션 키 유형에 따라 `promptMode`가 결정된다:

| 세션 유형 | 세션 키 패턴 | promptMode | task 지시 포함 여부 |
|-----------|------------|------------|-------------------|
| 메인 에이전트 | `agent:eden:main` | `"full"` | ✅ 포함 |
| 서브에이전트 | `agent:eden:subagent:*` | `"minimal"` | ❌ 미포함 |
| A2A 수신 | `agent:eden:a2a:{conversationId}` | `"minimal"` | ❌ 미포함 |
| Cron | `agent:eden:cron:*` | `"minimal"` | ❌ 미포함 |

### 1.3 두 가지 실행 모드 비교

**Mode 1: Direct (Main)** — `agent:eden:main`

```
promptMode = "full"
  → task 지시 포함 ✅
Task Enforcer 활성화
  → write/edit/bash 차단 ✅
task_* 도구 사용 가능 ✅
결과: 강제 실행 정상 동작
```

**Mode 2: A2A 수신** — `agent:eden:a2a:{conversationId}`

```
promptMode = "minimal"
  → task 지시 미포함 ❌
Task Enforcer 활성화 (A2A는 서브에이전트가 아니므로 exemption 없음) ✅
  → write/edit/bash 차단 시도
그러나 시스템 프롬프트에 task_start 지시 없음
  → 에이전트가 왜 차단되는지 모름
결과: stale task file bypass에 의존 (아래 참조)
```

---

## 2. 근본 원인 분석

### 2.1 근본 원인 #1: Stale Task File Bypass (HIGH 심각도)

Task Enforcer는 `task_start`가 호출되지 않았을 때 디스크의 기존 task 파일을 확인하는 폴백 로직을 갖고 있다:

```typescript
// task-enforcer.ts:213-229
if (!hasStartedTask && ctx.agentId) {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, ctx.agentId);
  const hasTasksOnDisk = await hasActiveTaskFiles(workspaceDir, ctx.agentId);
  if (hasTasksOnDisk) {
    taskStartedSessions.set(sessionKey, Date.now());
    hasStartedTask = true;  // ← task_start 없이 write/edit/bash 허용
  }
}
```

이 로직의 의도는 게이트웨이 재시작 후에도 진행 중인 task가 있으면 에이전트가 계속 작업할 수 있도록 하는 것이다. 그러나 **치명적인 범위 오류**가 있다.

#### hasActiveTaskFiles() 구현 (lines 109-155)

```typescript
// task-enforcer.ts:109-155 (간략화)
async function hasActiveTaskFiles(
  workspaceDir: string,
  agentId: string,
): Promise<boolean> {
  const tasksDir = path.join(workspaceDir, "tasks");
  const files = await fs.readdir(tasksDir);

  for (const file of files) {
    if (!file.startsWith("task_") || !file.endsWith(".md")) continue;
    const content = await fs.readFile(path.join(tasksDir, file), "utf-8");

    // in_progress, pending, pending_approval 상태 확인
    if (/\*\*Status:\*\* (in_progress|pending|pending_approval)/.test(content)) {
      return true;  // ← 하나라도 있으면 즉시 true 반환
    }
  }
  return false;
}
```

#### 핵심 문제: agentId 범위 vs. 세션 범위

```
체크 범위: agentId (에이전트 전체)
필요한 범위: sessionKey (현재 세션)

결과:
  - 이전 세션의 오래된 task 파일이 존재하면
  - 새 세션에서도 task_start 없이 작업 도구 사용 가능
  - 캐시 TTL: 30초 (task-enforcer 내부)
  - 세션 TTL: 24시간
  - → 오래된 task 파일이 24시간 동안 모든 새 세션의 강제 실행을 우회
```

#### 우회 시나리오

```
시간순:
1. 에이전트 eden이 task_start("보고서 작성") 호출
   → tasks/task_abc123.md 생성 (status: in_progress)

2. 게이트웨이 재시작 또는 새 대화 시작
   → 새 세션 키: agent:eden:a2a:conv456

3. 새 세션에서 write 도구 호출 시도
   → task_start 호출 없음
   → hasActiveTaskFiles() 실행
   → tasks/task_abc123.md 발견 (status: in_progress)
   → hasStartedTask = true ← 우회 성공!

4. 에이전트가 task 추적 없이 무제한 write/edit/bash 사용 가능
```

**캐시 동작**:

```typescript
// task-enforcer.ts (간략화)
const DISK_CHECK_CACHE_TTL_MS = 30_000; // 30초 캐시

// 30초마다 디스크 재확인
// → 오래된 task 파일이 있는 한 30초마다 bypass 갱신
```

### 2.2 근본 원인 #2: A2A 세션 프롬프트 공백 (MEDIUM 심각도)

A2A 세션은 `promptMode="minimal"`을 사용하므로 시스템 프롬프트에서 task 추적 지시가 제외된다.

```typescript
// system-prompt.ts:440-451 (간략화)
// promptMode="full"일 때만 포함:
if (promptMode === "full") {
  sections.push(`
⚠️ HARD RULE: If task_start and task_complete tools are available,
all substantive work must be tracked with tasks.
  `);
}
// promptMode="minimal"이면 이 섹션 전체 생략
```

**결과**:

- A2A 에이전트는 task_start를 호출해야 한다는 지시를 받지 못함
- Task Enforcer가 write/edit/bash를 차단하면 에이전트는 이유를 모름
- 에이전트가 stale task file bypass에 의존하거나 작업을 포기함

#### 서브에이전트 vs. A2A 세션의 Enforcer 처리 차이

```typescript
// task-enforcer.ts:166 (간략화)
// 서브에이전트 세션은 명시적으로 exemption
if (isSubagentSessionKey(sessionKey)) {
  return "allow";  // 서브에이전트는 task 도구 없으므로 전체 면제
}

// A2A 세션은 exemption 없음
// → Enforcer가 차단 시도하지만 에이전트는 task_start 지시를 받지 못함
```

이 불일치가 A2A 세션에서 혼란을 야기한다:
- 서브에이전트: task 도구 없음 + enforcer 면제 (일관성 있음)
- A2A 세션: task 도구 있음 + enforcer 활성화 + 지시 없음 (불일치)

---

## 3. 영향 범위

### 3.1 현재 상태: 이든만이 아닌 전체 에이전트 문제

**이 문제는 이든(Eden)에서만 발생하는 것이 아니라, 전체 11개 에이전트 모두에 해당한다.**

#### 코드 근거: 에이전트별 분기 없음

`taskEnforcerHandler`는 `ctx.agentId`를 사용하여 workspace 경로를 resolve하지만, **특정 에이전트를 필터링하거나 분기하는 로직이 존재하지 않는다**:

```typescript
// task-enforcer.ts:157-243 — 전체 핸들러
export async function taskEnforcerHandler(event, ctx) {
  // ① subagent 면제 (session key 기반, agent ID 무관)
  if (ctx.sessionKey?.includes("subagent:")) return;

  // ② exempt/enforced 도구 분류 (agent ID 무관)
  if (EXEMPT_TOOLS.has(toolName)) return;
  if (!ENFORCED_TOOLS.has(toolName)) return;

  // ③ 디스크 체크 (agent ID로 workspace 경로만 resolve, 필터링 없음)
  if (!hasStartedTask && ctx.agentId) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, ctx.agentId);
    const hasTasksOnDisk = await hasActiveTaskFiles(workspaceDir, ctx.agentId);
    // ...
  }
  // → eden, ruda, seum, dajim 등 모든 에이전트에 동일 로직 적용
}
```

#### 에이전트별 취약도 분석

| 에이전트 | ID | 역할 | Stale Task 위험 | A2A 수신 빈도 | 종합 위험도 |
|----------|-----|------|----------------|--------------|------------|
| 루다 | ruda | 오케스트레이터 | 🔴 높음 (모든 작업 조율) | 🔴 높음 (모든 에이전트와 소통) | **Critical** |
| 이든 | eden | 백엔드 개발 | 🔴 높음 (코드 작성 빈번) | 🔴 높음 (업무 위임 수신 빈번) | **Critical** |
| 세움 | seum | 인프라/배포 | 🟡 중간 | 🟡 중간 (배포 요청) | **High** |
| 다짐 | dajim | QA/테스팅 | 🟡 중간 | 🟡 중간 (리뷰 요청) | **High** |
| 윤슬 | yunseul | 마케팅/디자인 | 🟢 낮음 | 🟢 낮음 | Medium |
| 미리 | miri | 비즈니스 분석 | 🟢 낮음 | 🟡 중간 | Medium |
| 온새 | onsae | 개인비서 | 🟢 낮음 | 🟢 낮음 | Low |
| 이음 | ieum | 소셜/커뮤니티 | 🟢 낮음 | 🟢 낮음 | Low |
| 누리 | nuri | CS/커뮤니티 | 🟢 낮음 | 🟢 낮음 | Low |
| 한결 | hangyeol | 법무 | 🟢 낮음 | 🟢 낮음 | Low |
| 그림 | grim | UI/UX | 🟢 낮음 | 🟢 낮음 | Low |

**핵심**: 작업 빈도가 높은 에이전트(ruda, eden, seum)일수록 stale task 파일이 쌓일 확률이 높고, A2A 수신도 잦아 두 bypass 경로에 모두 노출된다.

#### 재현 시나리오 (모든 에이전트에 동일)

```
1. 에이전트 A가 task_start() → 작업 수행 → 비정상 종료 (task_complete 미호출)
2. workspace/tasks/task_xxx.md 파일이 status: in_progress로 남음
3. 에이전트 A의 새 세션 시작
4. write 호출 → enforcer가 disk check → task_xxx.md 발견 → "task 있음" 판정
5. task_start 없이 write/edit/bash 허용 ← BYPASS
6. 이후 모든 세션에서 반복 (task 파일이 삭제될 때까지)
```

### 3.2 위험 평가

| 위험 | 설명 |
|------|------|
| **task 추적 무력화** | 에이전트가 task 없이 write/edit/bash를 무제한 사용 가능 |
| **감사 추적 부재** | 어떤 작업이 어떤 task 맥락에서 수행되었는지 기록 없음 |
| **의도치 않은 파일 수정** | task 없이 코드베이스를 수정해도 추적 불가 |
| **A2A 에이전트 혼란** | 차단 이유를 모르는 에이전트가 예측 불가능한 동작 |

### 3.3 영향 받는 파일

| 파일 | 역할 | 관련 라인 |
|------|------|----------|
| `src/plugins/core-hooks/task-enforcer.ts` | Hard enforcement 훅 | 157-243 (enforcer 로직), 109-155 (disk check) |
| `src/agents/system-prompt.ts` | Task 지시 텍스트 | 440-451 |
| `src/agents/pi-tools.policy.ts` | 서브에이전트 도구 거부 | 58-77 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | promptMode 결정 | 426-431 |
| `src/sessions/session-key-utils.ts` | 세션 키 유형 감지 | 전체 |
| `src/plugins/hook-runner-global.ts` | 훅 등록 | 25 |

---

## 4. 제안 수정안

### Fix #1: 디스크 체크를 현재 세션 범위로 제한 (최소 필수 수정)

**현재 동작**: agentId 기준으로 task 파일 존재 여부 확인
**수정 후**: 현재 세션 또는 대화와 연결된 task 파일만 확인

#### 옵션 A: Task 파일에 세션 ID 메타데이터 추가

```typescript
// task-tool.ts (수정)
// task 파일 생성 시 세션 키 기록
interface TaskFile {
  taskId: string;
  status: TaskStatus;
  description: string;
  // ★ 신규 필드
  createdBySessionKey?: string;
  createdAt: number;
  // ...
}

// task 파일 헤더 예시:
// **Task ID:** task_abc123
// **Status:** in_progress
// **Created By Session:** agent:eden:main  ← 신규
// **Created At:** 2026-02-19T10:30:00Z
```

```typescript
// task-enforcer.ts (수정)
async function hasActiveTaskFilesForSession(
  workspaceDir: string,
  agentId: string,
  sessionKey: string,  // ★ 세션 키 추가
): Promise<boolean> {
  const tasksDir = path.join(workspaceDir, "tasks");
  const files = await fs.readdir(tasksDir);

  for (const file of files) {
    if (!file.startsWith("task_") || !file.endsWith(".md")) continue;
    const content = await fs.readFile(path.join(tasksDir, file), "utf-8");

    const isActive = /\*\*Status:\*\* (in_progress|pending|pending_approval)/.test(content);
    if (!isActive) continue;

    // ★ 세션 키 매칭 확인
    const sessionMatch = content.match(/\*\*Created By Session:\*\* (.+)/);
    if (sessionMatch && sessionMatch[1].trim() === sessionKey) {
      return true;
    }

    // 세션 키 메타데이터 없는 기존 파일은 무시 (마이그레이션 기간)
    // 또는 agentId 기반 폴백 (선택적)
  }
  return false;
}
```

#### 옵션 B: 시간 기반 필터링

```typescript
// task-enforcer.ts (수정)
const SESSION_TASK_WINDOW_MS = 4 * 60 * 60 * 1000; // 4시간

async function hasActiveTaskFilesForSession(
  workspaceDir: string,
  agentId: string,
  sessionKey: string,
): Promise<boolean> {
  const tasksDir = path.join(workspaceDir, "tasks");
  const files = await fs.readdir(tasksDir);
  const now = Date.now();

  for (const file of files) {
    if (!file.startsWith("task_") || !file.endsWith(".md")) continue;

    const filePath = path.join(tasksDir, file);
    const stat = await fs.stat(filePath);

    // ★ 최근 N시간 이내에 생성/수정된 파일만 확인
    if (now - stat.mtimeMs > SESSION_TASK_WINDOW_MS) continue;

    const content = await fs.readFile(filePath, "utf-8");
    if (/\*\*Status:\*\* (in_progress|pending|pending_approval)/.test(content)) {
      return true;
    }
  }
  return false;
}
```

**권장**: 옵션 A (세션 ID 메타데이터)가 더 정확하지만 task 파일 스키마 변경이 필요하다. 옵션 B는 즉시 적용 가능하지만 시간 기반이라 엣지 케이스가 있다. **두 옵션을 조합**하는 것이 가장 안전하다.

### Fix #2: Stale Task 파일 자동 정리

```typescript
// task-enforcer.ts 또는 별도 cleanup 모듈 (신규)

const STALE_TASK_THRESHOLD_HOURS = 24;

/**
 * 에이전트 세션 시작 시 오래된 task 파일을 정리한다.
 * in_progress 상태이지만 N시간 이상 업데이트되지 않은 task를 abandoned로 변경.
 */
async function cleanupStaleTasks(
  workspaceDir: string,
  agentId: string,
): Promise<void> {
  const tasksDir = path.join(workspaceDir, "tasks");
  const files = await fs.readdir(tasksDir).catch(() => []);
  const threshold = Date.now() - STALE_TASK_THRESHOLD_HOURS * 60 * 60 * 1000;

  for (const file of files) {
    if (!file.startsWith("task_") || !file.endsWith(".md")) continue;

    const filePath = path.join(tasksDir, file);
    const stat = await fs.stat(filePath);

    // 마지막 수정 시간이 임계값보다 오래된 경우
    if (stat.mtimeMs < threshold) {
      const content = await fs.readFile(filePath, "utf-8");
      if (/\*\*Status:\*\* (in_progress|pending)/.test(content)) {
        // status를 abandoned로 변경
        const updated = content.replace(
          /\*\*Status:\*\* (in_progress|pending)/,
          "**Status:** abandoned",
        );
        await fs.writeFile(filePath, updated, "utf-8");
        // 정리 로그 기록
        logger.info({ agentId, file }, "Cleaned up stale task file");
      }
    }
  }
}
```

**호출 시점**: 에이전트 세션 초기화 시 (`pi-embedded-runner/run/attempt.ts`에서 세션 시작 직후).

### Fix #3: A2A 세션 Task 지시 포함

A2A 세션에서도 task 도구가 사용 가능하다면, 시스템 프롬프트에 최소한의 task 지시를 포함해야 한다.

#### 옵션 A: 새로운 promptMode 레벨 추가

```typescript
// pi-embedded-runner/run/attempt.ts (수정)
const promptMode =
  isSubagentSessionKey(params.sessionKey)
    ? "minimal"           // 서브에이전트: task 도구 없음, 지시 불필요
    : isCronSessionKey(params.sessionKey)
    ? "minimal"           // Cron: 최소 모드
    : isA2ASessionKey(params.sessionKey)
    ? "a2a"               // ★ 신규: A2A 전용 모드
    : "full";             // 메인: 전체 모드
```

```typescript
// system-prompt.ts (수정)
// promptMode="a2a"일 때 최소 task 지시 포함
if (promptMode === "full" || promptMode === "a2a") {
  sections.push(`
⚠️ TASK TRACKING REQUIRED: If task_start and task_complete tools are available,
use them to track your work. Call task_start before using write, edit, or bash tools.
  `);
}
```

#### 옵션 B: 도구 가용성 기반 조건부 포함

```typescript
// system-prompt.ts (수정)
// task_start 도구가 도구 목록에 있으면 항상 지시 포함
const hasTaskTools = availableTools.some((t) => t.name === "task_start");
if (hasTaskTools) {
  sections.push(TASK_MANDATE_TEXT);
}
```

**권장**: 옵션 B가 더 견고하다. 도구 가용성을 직접 확인하므로 promptMode 로직 변경 없이 적용 가능하다.

### Fix #4: 세션 범위 강제 실행 (종합 수정)

`taskStartedSessions` 맵의 키를 agentId가 아닌 sessionKey로 변경하여 세션 간 상태 공유를 차단한다.

```typescript
// task-enforcer.ts (현재)
// taskStartedSessions: Map<sessionKey, timestamp>
// ← 이미 sessionKey를 키로 사용하지만,
//    disk check 결과를 sessionKey에 저장할 때 agentId 기준으로 조회함

// 수정 후: disk check 자체를 sessionKey 범위로 제한
// (Fix #1과 동일한 방향)
```

---

## 5. 수정안 우선순위

```
우선순위 순서:

1. Fix #1 (디스크 체크 세션 범위 제한) — 최소 필수 수정
   → 근본 원인 #1 직접 해결
   → 노력: 소 (0.5일)
   → 위험: 낮음 (기존 동작 변경 최소화)

2. Fix #3 (A2A 세션 task 지시 포함) — 중요 보완
   → 근본 원인 #2 해결
   → 노력: 소 (2-3시간)
   → 위험: 낮음 (시스템 프롬프트 텍스트 추가)

3. Fix #2 (Stale task 자동 정리) — 장기 안정성
   → 오래된 파일 누적 방지
   → 노력: 소 (3-4시간)
   → 위험: 중간 (task 파일 수정 로직)

4. Fix #4 (세션 범위 강제 실행) — Fix #1 포함
   → Fix #1과 함께 구현하면 추가 노력 없음
```

---

## 6. 구현 계획

### Phase 1: 즉시 수정 (0.5일)

| 단계 | 작업 | 파일 |
|------|------|------|
| 1.1 | task 파일 생성 시 `createdBySessionKey` 메타데이터 추가 | `task-tool.ts` (수정) |
| 1.2 | `hasActiveTaskFiles()`를 세션 키 기반으로 변경 | `task-enforcer.ts` (수정) |
| 1.3 | 기존 task 파일 호환성 처리 (메타데이터 없는 파일 폴백) | `task-enforcer.ts` (수정) |
| 1.4 | 유닛 테스트: 세션 범위 체크 | `task-enforcer.test.ts` (수정) |

### Phase 2: A2A 프롬프트 수정 (2-3시간)

| 단계 | 작업 | 파일 |
|------|------|------|
| 2.1 | 도구 가용성 기반 task 지시 조건부 포함 | `system-prompt.ts` (수정) |
| 2.2 | A2A 세션 task 지시 텍스트 작성 (minimal 버전) | `system-prompt.ts` (수정) |
| 2.3 | 통합 테스트: A2A 세션에서 task 지시 확인 | `system-prompt.test.ts` (수정) |

### Phase 3: Stale Task 정리 (3-4시간)

| 단계 | 작업 | 파일 |
|------|------|------|
| 3.1 | `cleanupStaleTasks()` 함수 구현 | `task-enforcer.ts` 또는 신규 모듈 |
| 3.2 | 세션 시작 시 cleanup 호출 | `pi-embedded-runner/run/attempt.ts` (수정) |
| 3.3 | 정리 임계값 설정 가능하게 (config) | `task-enforcer.ts` (수정) |
| 3.4 | 유닛 테스트: stale task 정리 로직 | 신규 테스트 |

---

## 7. 영향 받는 파일 요약

| 파일 | 변경 유형 | 변경 범위 |
|------|----------|----------|
| `src/plugins/core-hooks/task-enforcer.ts` | 수정 | +30 LOC (세션 범위 체크, stale 정리) |
| `src/agents/system-prompt.ts` | 수정 | +10 LOC (A2A 세션 task 지시) |
| `src/agents/tools/task-tool.ts` | 수정 | +5 LOC (세션 키 메타데이터) |
| `src/agents/pi-embedded-runner/run/attempt.ts` | 수정 (선택) | +3 LOC (cleanup 호출) |

**총 신규/수정 코드**: ~50 LOC

---

## 8. 테스트 전략

### 8.1 유닛 테스트

```typescript
// task-enforcer.test.ts (수정)

describe("Task Enforcer - Session Scope", () => {
  it("should allow work tools when task_start was called in current session");
  it("should block work tools when no task_start in current session");
  it("should NOT bypass enforcement using task files from other sessions");
  it("should NOT bypass enforcement using task files from previous sessions");
  it("should bypass enforcement when current session has active task file");
  it("should cache disk check result for 30 seconds per session");
});

describe("Task Enforcer - Stale Task Cleanup", () => {
  it("should mark in_progress tasks older than threshold as abandoned");
  it("should not modify recently updated task files");
  it("should not modify completed or failed task files");
  it("should log cleanup actions");
});
```

### 8.2 통합 테스트

```typescript
// task-enforcement.e2e.test.ts (신규)

describe("Task Enforcement E2E", () => {
  it("main session: write blocked without task_start");
  it("main session: write allowed after task_start");
  it("a2a session: write blocked without task_start");
  it("a2a session: write allowed after task_start");
  it("a2a session: system prompt includes task mandate");
  it("stale task file from session A does not bypass enforcement in session B");
  it("gateway restart: active task file from same session allows work");
  it("gateway restart: active task file from different session does not bypass");
});
```

---

## 9. 위험 평가

| 위험 | 영향 | 확률 | 대응 |
|------|------|------|------|
| 기존 task 파일 호환성 깨짐 | 중간 | 낮음 | 메타데이터 없는 파일에 대한 폴백 로직 유지 (마이그레이션 기간) |
| 게이트웨이 재시작 후 정상 작업 차단 | 높음 | 낮음 | 세션 키 메타데이터로 동일 세션 task 파일 정확히 식별 |
| Stale 정리가 진행 중인 task 삭제 | 높음 | 낮음 | 임계값을 충분히 크게 설정 (기본 24시간), 삭제 아닌 상태 변경만 수행 |
| A2A 프롬프트 변경으로 에이전트 동작 변화 | 중간 | 중간 | 최소한의 지시 텍스트만 추가, 기존 동작 변경 최소화 |

---

## 10. 의존성

### 10.1 선행 의존성

| 의존 대상 | 필요 이유 | 없으면? |
|-----------|----------|---------|
| 없음 (독립적) | task-enforcer와 system-prompt는 이미 존재 | - |

### 10.2 후행 활용

| 활용 대상 | 활용 방식 |
|-----------|----------|
| #11 서브에이전트-Task 통합 | 세션 범위 task 추적이 정확해지면 delegation 연결도 더 신뢰할 수 있음 |
| #09 조정 불변량 테스트 | task enforcement 불변량을 테스트 스위트에 추가 가능 |
| #04 계속실행 상태머신 | 정확한 task 상태가 continuation 결정에 활용 가능 |

---

## 11. 노력 추정

| Phase | 내용 | 추정 |
|-------|------|------|
| Phase 1 | 디스크 체크 세션 범위 제한 + 테스트 | 0.5일 |
| Phase 2 | A2A 세션 프롬프트 수정 + 테스트 | 0.25일 |
| Phase 3 | Stale task 정리 + 테스트 | 0.25일 |
| **합계** | | **1일** |

**최소 필수 수정 (Fix #1만)**: 0.5일

---

## 12. 성공 기준

구현이 성공적이라면 다음이 보장되어야 한다:

1. **세션 격리**: 이전 세션의 task 파일이 새 세션의 강제 실행을 우회하지 못함
2. **A2A 일관성**: A2A 세션에서도 에이전트가 task_start 지시를 받음
3. **게이트웨이 재시작 호환성**: 동일 세션의 진행 중인 task는 재시작 후에도 인식됨
4. **Stale 파일 정리**: 오래된 task 파일이 자동으로 정리되어 누적되지 않음
5. **역호환성**: 기존 메타데이터 없는 task 파일도 마이그레이션 기간 동안 정상 동작

---

## 13. 변경 이력

| 날짜 | 변경 내용 |
|------|-----------|
| 2026-02-19 | 초기 문서 작성 (코드 분석 기반) |
