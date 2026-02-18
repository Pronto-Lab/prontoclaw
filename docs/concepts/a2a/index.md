# A2A (Agent-to-Agent) 비동기 통신 시스템

> 구현 완료: 2026-02-18
> 대상: prontolab-openclaw, task-monitor, task-hub

## 개요

에이전트 간 비동기 통신(A2A) 시스템의 설계 및 구현 문서입니다.
4개의 핵심 설계와 E2E 테스트 결과, 그리고 Task-Hub 협업 허브 구현을 포함합니다.

## 문서 목록

### 설계 문서

| 문서                                                | 설명                                        | 상태    |
| --------------------------------------------------- | ------------------------------------------- | ------- |
| [병렬 실행](./parallel-execution.md)                | 2중 순차 큐잉 → 병렬 A2A 실행               | ✅ 완료 |
| [Task-Monitor 실시간성](./task-monitor-realtime.md) | EventCache, MongoDB 동기화, WS 강화         | ✅ 완료 |
| [재시도 및 에러 복구](./retry-error-recovery.md)    | 에러 분류 체계, 재시도 전략, CircuitBreaker | ✅ 완료 |
| [핑퐁 최적화](./pingpong-optimization.md)           | 턴 제어, 응답 품질, 의도 분류               | ✅ 완료 |

### 협업 허브 (Phase 9)

| 문서                                        | 설명                                         | 상태    |
| ------------------------------------------- | -------------------------------------------- | ------- |
| [Collaboration Hub](./collaboration-hub.md) | 에이전트 지시, 팀 메시징, 대화 개입, AI 요약 | ✅ 완료 |

### 테스트

| 문서                                     | 설명                          | 결과       |
| ---------------------------------------- | ----------------------------- | ---------- |
| [E2E 테스트 결과](./e2e-test-results.md) | 28개 테스트, 전체 시스템 검증 | 28/28 PASS |

## 아키텍처 개요

```mermaid
graph TB
    subgraph OpenClaw["OpenClaw (Gateway :18789)"]
        SS[sessions_send tool]
        A2A[A2A Flow Engine]
        PP[Ping-Pong Controller]
        IC[Intent Classifier]
        RR[Retry & Recovery]
    end

    subgraph TM["Task-Monitor (:3847)"]
        EC[EventCache]
        WS[WebSocket Server]
        MDB[(MongoDB)]
        API[REST API]
    end

    subgraph TH["Task-Hub (:3102)"]
        CV[Conversations View]
        MI[MessageInput]
        SP[SummaryPanel]
        SSE[SSE Bridge]
        AS[Agent Send API]
        TS[Team Send API]
        SUM[Summarize API]
    end

    SS --> A2A
    A2A --> PP
    A2A --> IC
    A2A --> RR
    A2A -->|coordination event| EC
    EC -->|sync| MDB
    EC -->|broadcast| WS
    WS -->|bridge| SSE
    SSE --> CV
    API -->|query| MDB
    MI -->|POST| AS
    MI -->|POST| TS
    AS -->|sessions_send| SS
    TS -->|sessions_send ×N| SS
    SP -->|POST| SUM
    SUM -->|fetch| API
    SUM -->|stream| SP
```

## 관련 문서

- [Multi-Agent Coordination](/MULTI-AGENT-COORDINATION.md) — 전체 멀티에이전트 시스템 개요
- [Collaboration Event Model](/concepts/collaboration-event-model.md) — 이벤트 모델 정의
- [Session Tool](/concepts/session-tool.md) — 세션 도구 상세
