# 소스 코드 참조 + 설정 스냅샷

> Sisyphus 패턴 구현 시 참고할 소스 코드 위치와 현재 설정 상태.
>
> 관련 문서: [SISYPHUS-DESIGN.md](./SISYPHUS-DESIGN.md) | [IMPLEMENTATION-GUIDE.md](./IMPLEMENTATION-GUIDE.md)

---

## 1. 핵심 코드 참조

### 1.1 Workspace 결정

**파일**: `src/agents/agent-scope.ts:168-184`

```typescript
export function resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
  if (configured) return resolveUserPath(configured);
  // ... 기본 에이전트 fallback ...
  const stateDir = resolveStateDir(process.env);
  return path.join(stateDir, `workspace-${id}`);
}
```

**동작**: `agentId`가 `"explorer"`이면 `~/.openclaw/workspace-explorer/`에서 bootstrap 파일 로드.

### 1.2 sessions_spawn 도구

**파일**: `src/agents/tools/sessions-spawn-tool.ts`

핵심 로직 (현재 구현 기준):

```typescript
const targetAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : requesterAgentId; // agentId 미지정 → 부모 자신

if (targetAgentId !== requesterAgentId) {
  const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
  // allowAgents에 없으면 forbidden 반환
}

const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
```

스키마 파라미터: `task`(필수), `label`, `agentId`, `model`, `thinking`, `runTimeoutSeconds`, `cleanup`

Sub-agent 재귀 차단: `isSubagentSessionKey` 체크로 sub-agent의 sub-agent spawn 금지.

### 1.3 Sub-Agent 도구 정책

**파일**: `src/agents/pi-tools.policy.ts`

```typescript
const DEFAULT_SUBAGENT_TOOL_DENY = [
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "gateway",
  "agents_list",
  "whatsapp_login",
  "session_status",
  "cron",
  "memory_search",
  "memory_get",
  "task_start",
  "task_update",
  "task_complete",
  "task_status",
  "task_list",
  "task_cancel",
  "task_block",
  "task_approve",
  "task_resume",
  "task_backlog_add",
  "task_pick_backlog",
  "milestone_list",
  "milestone_create",
  "milestone_add_item",
  "milestone_assign_item",
  "milestone_update_item",
];
```

Config의 `tools.subagents.tools.deny`가 `DEFAULT_SUBAGENT_TOOL_DENY`에 합산됨.

### 1.4 Sub-Agent 시스템 프롬프트

**파일**: `src/agents/subagent-announce.ts:374-424`

`buildSubagentSystemPrompt()` — ~20줄 고정 시스템 프롬프트 생성.
내용: Subagent Context, Role, Rules (Stay focused, Complete task, Be ephemeral), Output Format.

### 1.5 promptMode 결정

**파일**: `src/agents/pi-embedded-runner/run/attempt.ts:342`

```typescript
const promptMode = isSubagentSessionKey(params.sessionKey) ? "minimal" : "full";
```

`promptMode="minimal"` 효과: Self-Update, Model Aliases, Group Chat Context 등 생략.
단, **Task Tracking (CRITICAL - MANDATORY)는 여전히 포함됨** (system-prompt.ts:414-417).

### 1.6 Bootstrap 파일

**파일**: `src/agents/workspace.ts:23-31`

파일 목록: `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md`

**한도**: `DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000` (`src/agents/pi-embedded-helpers/bootstrap.ts:85`)
초과 시 head 70% + tail 20% + 중간 생략 방식으로 트리밍.

Sub-agent는 bootstrap 시 **AGENTS.md와 TOOLS.md만** 로딩 (filterBootstrapFilesForSession).

---

## 2. Config 타입 참조

### 2.1 tools.subagents

```typescript
// src/config/types.tools.ts:446-453
subagents?: {
  tools?: {
    allow?: string[];  // 허용 목록 (설정 시 이것만 허용)
    deny?: string[];   // 추가 차단 목록 (DEFAULT에 합산)
  };
};
```

### 2.2 agents.defaults.subagents

```typescript
// src/config/types.agent-defaults.ts:210-223
subagents?: {
  maxConcurrent?: number;
  archiveAfterMinutes?: number;
  model?: string | ModelConfig;
  thinking?: string;
  announceDeliveryTimeoutMs?: number;
};
```

### 2.3 per-agent subagents

```typescript
// src/config/zod-schema.agent-runtime.ts:472-489
subagents?: {
  allowAgents?: string[];    // cross-agent spawn 허용 대상
  model?: string | ModelConfig;
  thinking?: string;
};
```

---

## 3. 에이전트 설정 스냅샷 (2026-02-12)

### 3.1 에이전트 목록

| ID       | 이름 | 역할          | 모델       | AGENTS.md 크기 | Bootstrap 한도 대비 |
| -------- | ---- | ------------- | ---------- | -------------- | ------------------- |
| ruda     | 루다 | 팀 리더       | opus-4-6   | 21,458 bytes   | 초과 (트리밍됨)     |
| eden     | 이든 | 개발          | opus-4-5   | 23,886 bytes   | 초과 (트리밍됨)     |
| seum     | 세움 | 인프라        | opus-4-5   | 18,182 bytes   | 91%                 |
| dajim    | 다짐 | QA            | opus-4-5   | 14,320 bytes   | 72%                 |
| yunseul  | 윤슬 | 마케팅        | sonnet-4-5 | 17,140 bytes   | 86%                 |
| miri     | 미리 | 비즈니스 분석 | sonnet-4-5 | 16,762 bytes   | 84%                 |
| onsae    | 온새 | 개인비서      | sonnet-4-5 | 18,256 bytes   | 91%                 |
| ieum     | 이음 | 소셜 커뮤니티 | sonnet-4-5 | 8,016 bytes    | 40%                 |
| nuri     | 누리 | CS/커뮤니티   | sonnet-4-5 | 7,567 bytes    | 38%                 |
| hangyeol | 한결 | 법무          | sonnet-4-5 | 9,793 bytes    | 49%                 |
| grim     | 그림 | UI/UX         | sonnet-4-5 | 6,733 bytes    | 34%                 |

### 3.2 에이전트별 도구 설정

| 에이전트 | tools.allow                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| ruda     | read, write, edit, exec, web_search, web_fetch, message, group:sessions, group:task, group:milestone          |
| eden     | exec, read, write, edit, apply_patch, browser, web_search, web_fetch, message, group:sessions, group:task     |
| seum     | exec, read, write, edit, message, nodes, browser, web_search, web_fetch, group:sessions, group:task           |
| dajim    | read, write, edit, exec, web_search, web_fetch, message, group:sessions, group:task                           |
| yunseul  | read, write, edit, browser, web_search, web_fetch, message, group:sessions, group:task                        |
| miri     | read, write, edit, exec, browser, web_search, web_fetch, message, group:sessions, group:task, group:milestone |
| onsae    | read, write, edit, exec, web_search, web_fetch, message, group:sessions, group:task                           |
| ieum     | read, write, edit, web_search, web_fetch, message, group:sessions, group:task                                 |
| nuri     | read, write, edit, exec, web_search, web_fetch, message, group:sessions, group:task                           |
| hangyeol | read, write, edit, exec, web_search, web_fetch, message, group:sessions, group:task                           |
| grim     | read, write, edit, browser, web_search, web_fetch, message, group:sessions, group:task                        |

### 3.3 서버 환경

| 항목         | 값                                              |
| ------------ | ----------------------------------------------- |
| 서버         | Mac Mini (Yoonui-Macmini)                       |
| SSH          | `ssh -p 2222 server@ssh.speculatingwook.online` |
| 설정 파일    | `~/.openclaw/openclaw.json`                     |
| Workspace    | `~/.openclaw/workspace-{agentId}/`              |
| Gateway 포트 | 18789                                           |
| Task-Hub     | Docker (OrbStack), port 3102→3000               |

---

_작성일: 2026-02-16 | 기준 시점: 2026-02-16 서버 점검_
