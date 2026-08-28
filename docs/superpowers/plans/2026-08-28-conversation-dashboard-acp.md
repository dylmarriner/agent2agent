# Conversation Dashboard + ACP Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a canonical multi-party conversation runtime, automatic CLI/ACP discovery, realtime HTTP/SSE API, and React control center where the operator can observe and participate in real agent conversations.

**Architecture:** MCP/ACP/CLI remain transport adapters behind a canonical conversation service. The service owns participant identity, ordered messages, session reuse and event publication; Fastify exposes the service over HTTP/SSE and React renders only backend-derived state. ACP uses the stable official `@agentclientprotocol/sdk` v1.4.0 client API and unknown custom endpoints remain pending-trust.

**Tech Stack:** TypeScript 6, Node 22+, `@agentclientprotocol/sdk` 1.4.0, Fastify, React, Vite, Zod, SSE, PostgreSQL schema, existing Agent2Agent protocol/core/adapters.

**Spec:** `docs/superpowers/specs/2026-08-28-conversation-dashboard-acp-design.md`

## Global Constraints

- Keep TypeScript strict with `exactOptionalPropertyTypes`.
- Do not expose credentials, environment variables, credential paths, or executable paths through public APIs.
- Unknown/custom ACP endpoints default to `pending-trust`.
- ACP v1 is production; ACP v2 remains experimental and is not imported by runtime code.
- All execution paths preserve delegation-depth and cancellation controls.
- Human messages are persisted/published before downstream dispatch.
- UI displays only canonical backend messages/events; no simulated activity.
- Every significant slice must pass typecheck, lint, unit/integration tests and relevant e2e tests before merge.

---

### Task 1: Canonical Conversation Runtime

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/conversation/src/index.ts`
- Create: `packages/conversation/package.json`
- Test: `tests/conversation.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `ConversationRecord`, `ConversationParticipant`, `HumanMessageInput`, `ConversationRepository`, `InMemoryConversationRepository`, `ConversationRuntime`.
- `ConversationRuntime.create(...)`, `.list()`, `.get(id)`, `.messages(id)`, `.sendHumanMessage(...)`, `.sendAgentMessage(...)`.

- [ ] Write tests asserting conversation creation, participant identity, ordered sequence numbers, directed `@agent` routing, collective broadcast, and events.
- [ ] Run tests and verify failure because conversation runtime does not exist.
- [ ] Add protocol types and minimal in-memory conversation repository/runtime.
- [ ] Ensure human messages publish `message.created` before dispatch and use canonical sender `human:operator`.
- [ ] Run full validation.
- [ ] Commit `feat(conversation): add canonical multi-party runtime`.

### Task 2: Extend Local Discovery and Trust Model

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/adapters/src/discovery.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `tests/discovery.test.ts`

**Interfaces:**
- Extend registered-agent metadata with sanitized transport/trust evidence.
- Add `AgentTrustStatus = "trusted" | "pending-trust" | "disabled"`.

- [ ] Add failing tests for transport badges, known-runtime auto-trust, and custom ACP pending-trust.
- [ ] Extend known executable specs for Gemini/Copilot/Qwen/Kiro/Goose where safely probeable.
- [ ] Preserve existing Claude/Codex/Hermes/OpenCode/OpenClaw behavior.
- [ ] Ensure public metadata continues excluding executable paths.
- [ ] Run full validation.
- [ ] Commit `feat(discovery): add transport and trust evidence`.

### Task 3: ACP v1 Client Adapter

**Files:**
- Create: `packages/acp/package.json`
- Create: `packages/acp/src/index.ts`
- Modify: `package.json`
- Test: `tests/acp.test.ts`

**Interfaces:**
- Produces `AcpEndpointConfig`, `AcpClientTransport`, `AcpAgentAdapter`, `AcpPermissionHandler`.
- Uses official `@agentclientprotocol/sdk` v1.4.0 stable entry point.
- Adapter emits normalized `AgentEvent` from ACP `session/update` notifications.

- [ ] Write deterministic in-memory ACP agent/client tests for initialize, session/new, prompt, streamed message updates, cancellation and permission denial.
- [ ] Verify tests fail before implementation.
- [ ] Implement stable ACP v1 connection/session lifecycle with `client({name}).connectWith(...)`.
- [ ] Preserve ACP session IDs per Agent2Agent session and support load/resume only when advertised.
- [ ] Map ACP updates into normalized `delta`, `tool-call`, `tool-result`, `artifact`, `status`, and `error` events when representable.
- [ ] Run full validation.
- [ ] Commit `feat(acp): add stable ACP v1 client adapter`.

### Task 4: ACP Endpoint Discovery and Trust

**Files:**
- Create: `packages/acp/src/discovery.ts`
- Modify: `packages/acp/src/index.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `tests/acp-discovery.test.ts`

**Interfaces:**
- Produces `discoverAcpEndpoints`, `registerAcpEndpoints`.
- Known built-ins may auto-trust; custom endpoints register degraded/pending-trust and cannot execute until trusted.

- [ ] Write failing tests for known ACP endpoint registration and custom pending-trust.
- [ ] Implement config-driven endpoint discovery plus known runtime mapping.
- [ ] Refuse arbitrary PATH binaries without an explicit known spec or configured endpoint.
- [ ] Add trust transition method that emits audit/event evidence.
- [ ] Run full validation.
- [ ] Commit `feat(acp): discover and gate local ACP agents`.

### Task 5: HTTP + SSE Control Plane

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/src/runtime.ts`
- Create: `apps/api/src/server.ts`
- Modify: `package.json`
- Test: `tests/api.test.ts`

**Interfaces:**
- `createControlPlaneRuntime()` composes registry, conversation runtime, events, CLI discovery and ACP discovery.
- `buildApiServer(runtime)` exposes versioned endpoints and SSE.

- [ ] Write failing tests for agents, conversations, messages, trust endpoint, health and SSE replay.
- [ ] Add Fastify dependency pinned to current compatible major.
- [ ] Implement sanitized DTOs and HTTP routes.
- [ ] Implement SSE with event IDs, replay cursor and unsubscribe cleanup.
- [ ] Dispatch human direct/broadcast messages through the conversation runtime.
- [ ] Run full validation.
- [ ] Commit `feat(api): add realtime collective control plane`.

### Task 6: Conversation-to-Agent Dispatch Loop

**Files:**
- Modify: `packages/conversation/src/index.ts`
- Modify: `apps/api/src/runtime.ts`
- Test: `tests/conversation-dispatch.test.ts`

**Interfaces:**
- Produces `ConversationDispatcher` that invokes selected registered adapters and records both outbound and inbound canonical messages.

- [ ] Write failing tests showing human → Claude → Codex style directed turns remain in one conversation with identities and sequence order.
- [ ] Implement direct `@agent` dispatch and collective routing fallback.
- [ ] Reuse adapter sessions per conversation/agent with bounded cache.
- [ ] Emit invocation start/completion/error events and propagate cancellation/delegation depth.
- [ ] Run full validation.
- [ ] Commit `feat(conversation): dispatch live agent turns`.

### Task 7: React Web Control Center

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app.tsx`
- Create: `apps/web/src/api.ts`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/src/components/AgentDirectory.tsx`
- Create: `apps/web/src/components/ConversationViewer.tsx`
- Create: `apps/web/src/components/NetworkGraph.tsx`
- Modify: `package.json`
- Test: `tests/web-static.test.ts`

**Interfaces:**
- Browser consumes `/api/v1/*` and `/api/v1/events/stream`.
- Composer supports `@agent-id` and `@collective` syntax.

- [ ] Add failing static/build tests requiring dashboard routes/components and no mock transcript data.
- [ ] Add React/Vite dependencies.
- [ ] Build dashboard, agent directory, live transcript, network graph and composer.
- [ ] Use SSE reconnect to merge canonical events without duplicate IDs.
- [ ] Keep the transcript primary and network graph secondary.
- [ ] Run Vite build plus full validation.
- [ ] Commit `feat(web): add transparent collective control center`.

### Task 8: Persistence and End-to-End Acceptance

**Files:**
- Modify: `packages/database/migrations/0001_initial.sql` or add `packages/database/migrations/0002_conversation_runtime.sql`
- Create: `packages/conversation/src/postgres.ts`
- Test: `tests/e2e-dashboard.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- PostgreSQL repository implements `ConversationRepository` and event replay persistence contract.

- [ ] Add migration assertions for conversations, participants, messages, recipients, agent sessions/invocations and event replay indexes.
- [ ] Implement PostgreSQL repository behind the same interfaces used by deterministic tests.
- [ ] Add end-to-end deterministic test: auto-detected fake CLI/ACP agents → create conversation → human broadcast → agent-to-agent turn → SSE-visible events → transcript reload.
- [ ] Update README run commands and architecture truthfully.
- [ ] Run typecheck, lint, all tests, web build and deterministic demo.
- [ ] Request current-head code review and fix all material findings with regression tests.
- [ ] Squash-merge only the exact green reviewed head.
