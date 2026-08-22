# Agent2Agent

Agent2Agent is a federated collective-intelligence runtime for heterogeneous AI agents. It normalizes agent communication, task delegation, bounded swarms, isolated coding workspaces, memory, knowledge, evaluation and federation behind stable contracts.

This repository is under active implementation. The first vertical slice is intentionally deterministic and model-free so protocol, safety and learning behavior can be tested without paid APIs.

## Implemented vertical slice

- normalized collaboration/message/agent/task/memory/federation protocol types
- adapter registry with deterministic local adapter
- product integration descriptors for Hermes, OpenClaw, OpenCode, Claude Code and Codex
- task DAG with dependency validation
- bounded swarm runtime with depth/child/runtime/message/cost controls
- scoped authoritative memory with optional cognitive-provider fallback
- temporal knowledge graph
- evidence-gated shared intelligence
- benchmark baseline/candidate comparison with regression blocking
- federation hop, loop and replay guards
- conversation duplicate/round/message/consecutive-turn protection
- expert capability router
- workspace/branch isolation planning and review merge gates
- permission and SSRF policy primitives
- deterministic end-to-end collective demo
- PostgreSQL + pgvector initial authoritative schema

## Run locally

Requirements: Node.js 22+ and pnpm 10.33+.

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm demo
```

Run every currently implemented validation:

```bash
pnpm validate
```

The deterministic demo does not require a model API key.

## Architecture

```mermaid
flowchart TB
    Human[Human / Operator] --> Conversation[Conversation Engine]
    Conversation --> Router[Expert / Strategy Router]
    Conversation --> Tasks[Task DAG]
    Tasks --> Swarm[Bounded Swarm Runtime]
    Router --> Registry[Agent + Capability Registry]
    Registry --> Adapters[Normalized Adapter Runtime]
    Adapters --> Hermes[Hermes]
    Adapters --> OpenClaw[OpenClaw]
    Adapters --> OpenCode[OpenCode]
    Adapters --> Claude[Claude Agent SDK]
    Adapters --> Codex[Codex SDK]
    Conversation --> Memory[Hybrid Memory]
    Memory --> Authoritative[PostgreSQL / semantic store]
    Memory -. optional .-> STG[SCOS / STG]
    Conversation --> Graph[Temporal Knowledge Graph]
    Conversation --> Intelligence[Shared Intelligence]
    Intelligence --> Eval[Benchmark + Promotion Engine]
    Conversation --> Workspaces[Git Workspace Manager]
    Conversation --> Federation[Federation Guard / Mesh]
```

PostgreSQL remains the intended authoritative application datastore. SCOS/STG is an optional cognitive memory provider because its current API is alpha and its BUSL-1.1 licensing requires separate commercial terms for for-profit deployment.

## Integration policy

Current upstream integration decisions are recorded under [`docs/integrations/`](docs/integrations/). Product-specific behavior stays behind adapters. A2A and MCP are transport boundaries, not the internal domain model.

## Safety model

The runtime treats agents, remote nodes, memory, packages and model output as untrusted. Current core controls include bounded swarms, scoped memory, duplicate-message prevention, federation loop/replay protection, explicit permissions, merge review gates and SSRF target rejection. Enforcement is designed to live in runtime policy rather than prompts.

## Status

The full production brief includes PostgreSQL/pgvector persistence runtime, Redis workers, official A2A and MCP SDK transports, real vendor SDK adapters, Git worktree execution, merge-conflict reconciliation, package sandboxing, web control center, OpenTelemetry/Prometheus, Docker, Helm and multi-node live federation. Those are subsequent vertical slices and must not be represented as complete until their tests pass.
