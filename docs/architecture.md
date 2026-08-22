# Architecture

## Core rule

Agent2Agent owns a canonical domain protocol. Vendor SDKs and wire protocols are boundary adapters. This prevents A2A, MCP, a CLI transcript format, or a single model vendor from leaking into task orchestration and durable state.

## Data ownership

| Layer | Responsibility |
| --- | --- |
| PostgreSQL | authoritative transactional state and audit history |
| pgvector | semantic similarity candidates |
| Temporal graph | explicit typed relationships, provenance and validity windows |
| SCOS/STG | optional adaptive associative recall |
| Shared intelligence | governance of reusable claims, patterns, failures and skills |

A canonical ID links records across stores. Cognitive retrieval may fail without making transactional state unavailable.

## Runtime boundaries

```mermaid
flowchart LR
    API[API / MCP / A2A] --> Domain[Canonical Domain Runtime]
    Domain --> Queue[Distributed Job Queue]
    Queue --> Worker[Agent Workers]
    Worker --> Adapter[Agent Adapter]
    Adapter --> Product[Agent Product / Remote Node]
    Domain --> DB[(PostgreSQL)]
    Domain --> Memory[Memory Ranking]
    Memory --> Vector[(pgvector)]
    Memory -.-> STG[STG Sidecar]
    Domain --> Graph[Temporal Graph]
```

## Failure philosophy

- correctness never depends on process-local state in the production persistence slice
- optional integrations degrade independently
- retries require idempotency keys
- cancellation propagates through task, queue, adapter and subprocess boundaries
- branch/worktree ownership prevents concurrent mutation of one working tree
- learning is candidate generation until benchmark and policy gates promote it
