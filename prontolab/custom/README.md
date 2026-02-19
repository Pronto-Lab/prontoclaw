# ProntoLab Custom Docs

This directory collects ProntoLab-specific custom documents for quick access.

Canonical files are still kept at their original top-level prontolab paths to avoid breaking existing links.

Included:

- IMPLEMENTATION-GUIDE.md
- OPERATIONS-RUNBOOK.md
- REFERENCES.md
- SISYPHUS-DESIGN.md
- SYSTEM-ARCHITECTURE.md — 시스템 아키텍처 & 데이터 플로우 (Mermaid 다이어그램 포함)
- TASK-STEPS-DESIGN.md
- WORKSESSION-COLLAB-DESIGN.md
- deferred-fallback-discord-default-bot.md

### improvements/ — 아키텍처 개선 설계 문서

- [ARCHITECTURE-IMPROVEMENTS.md](./improvements/ARCHITECTURE-IMPROVEMENTS.md) — 전체 개선 인덱스, 우선순위 매트릭스, 실행 계획
- [01-a2a-conversation-index.md](./improvements/01-a2a-conversation-index.md) — A2A 대화 인덱스 (O(1) 조회)
- [02-a2a-durable-jobs.md](./improvements/02-a2a-durable-jobs.md) — A2A 내구성 잡 큐
- [03-task-tool-modularization.md](./improvements/03-task-tool-modularization.md) — task-tool.ts 모듈화 (2,296 LOC 분리)
- [04-continuation-state-machine.md](./improvements/04-continuation-state-machine.md) — 컨티뉴에이션 상태 머신
- [05-gateway-composition.md](./improvements/05-gateway-composition.md) — Gateway 조합 패턴 (server.impl.ts 분리)
- [06-dependency-injection.md](./improvements/06-dependency-injection.md) — 의존성 주입 체계화
- [07-a2a-concurrency-control.md](./improvements/07-a2a-concurrency-control.md) — A2A 동시성 제어
- [08-structured-handoff.md](./improvements/08-structured-handoff.md) — 구조화된 핸드오프 프로토콜
- [09-coordination-invariants-tests.md](./improvements/09-coordination-invariants-tests.md) — 조정 불변성 테스트
- [10-cross-plane-unification.md](./improvements/10-cross-plane-unification.md) — 크로스 플레인 통합
