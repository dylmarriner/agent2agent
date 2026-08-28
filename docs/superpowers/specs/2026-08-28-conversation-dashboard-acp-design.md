# Conversation Dashboard + ACP Discovery Design

## Goal

Make Agent2Agent a transparent collective operating surface rather than merely an MCP relay. The system must automatically discover supported local CLI and ACP agents, normalize them into one registry, persist multi-party conversations, stream live agent activity to a web dashboard, and allow the human operator to participate directly by broadcasting to the collective or addressing individual agents.

## Product model

MCP, ACP, CLI and A2A are transports. They are not the product boundary.

The product boundary is a canonical conversation runtime:

```text
Web Dashboard
    │
HTTP + SSE
    │
Conversation Runtime
    ├── Agent Registry
    ├── Task / Swarm Runtime
    ├── Event Store
    ├── Memory / Knowledge
    └── Transport Adapters
         ├── CLI
         ├── ACP v1
         ├── MCP
         └── A2A
```

Every participant interaction becomes a canonical message/event with stable IDs and provenance. The dashboard observes this real event stream and sends human messages into the same runtime.

## Human participation

Represent the operator as a participant identity, defaulting to `human:operator`.

Human messages support:

- direct messages: `@claude-local review this`
- multiple directed recipients
- broadcast: `@collective work this out together`
- ordinary unprefixed messages default to collective routing

The runtime records the human message before dispatch so the transcript remains truthful if downstream execution fails.

## Conversation runtime

Introduce persistent conversation entities with:

- conversation ID
- title/objective
- state: created, active, paused, completed, failed
- participant identities
- ordered canonical messages
- task/session references
- creation/update timestamps

Agent messages retain sender, recipients, intent, task, parent, correlation, round, sequence, artifacts and routing metadata.

The runtime publishes typed events for conversation lifecycle, participant changes, human messages, message routing/delivery, agent execution, tool activity and errors.

## Realtime UI

Use server-sent events for server-to-browser updates in the first production slice. Browser writes use normal HTTP requests. SSE reconnect uses event IDs and a replay cursor.

Screens in the first slice:

1. Dashboard
   - detected agents
   - active conversations
   - active executions
   - recent events
2. Agent Directory
   - name / canonical ID
   - CLI / ACP / MCP transport badges
   - readiness
   - trust status
   - capabilities
   - current conversation/task
3. Conversation Viewer
   - live ordered transcript
   - sender and recipients
   - intent badges
   - tool/activity events
   - artifacts/errors
   - human composer with @mentions
4. Network Graph
   - human, agents and subagents as nodes
   - message/delegation edges
   - live activity state

The dashboard never displays credentials, secret environment variables, credential-file paths or private executable paths.

## Local discovery

Extend the existing local CLI discovery service rather than replacing it.

Known CLI runtimes include the existing Claude Code, Codex, Hermes, OpenCode and OpenClaw integrations plus additional well-known executables when safely detectable (Gemini CLI, Copilot CLI, Qwen Code/Kiro/Goose where present).

Discovery produces canonical runtime evidence:

- executable presence
- version
- readiness/auth state where safely supported
- supported transports
- session/resume support
- streaming
- cancellation
- tools
- MCP
- ACP
- trust status

Known supported local runtimes may auto-enable. Unknown/custom ACP runtimes are registered as `pending-trust` and cannot execute collective work until explicitly trusted.

## ACP v1

Use official `@agentclientprotocol/sdk` v1.4.0 stable entry point. ACP v2 remains draft and is not a production dependency.

Agent2Agent acts as an ACP client. An ACP transport adapter must:

- initialize the ACP connection and negotiate `PROTOCOL_VERSION`
- create a session with cwd and MCP servers
- map `session/update` notifications into normalized `AgentEvent` and collective events
- route permission requests to a policy callback
- send prompts
- support cancellation
- preserve ACP session IDs for follow-up conversation turns
- load/resume sessions when the agent advertises the capability

ACP discovery is configuration-driven plus known-agent driven. The system must never execute arbitrary discovered binaries solely because they resemble an ACP endpoint.

## ACP trust

Each ACP endpoint has one of:

- trusted
- pending-trust
- disabled

Known built-in endpoint definitions can be trusted automatically when their executable matches the expected detected runtime. User-added/custom endpoints default to pending-trust.

## API

Initial HTTP API:

- `GET /api/v1/agents`
- `GET /api/v1/agents/:id`
- `POST /api/v1/agents/:id/trust`
- `GET /api/v1/conversations`
- `POST /api/v1/conversations`
- `GET /api/v1/conversations/:id`
- `GET /api/v1/conversations/:id/messages`
- `POST /api/v1/conversations/:id/messages`
- `GET /api/v1/events`
- `GET /api/v1/events/stream`
- `GET /api/v1/system/health`

The API serves the dashboard and remains separate from MCP.

## Persistence

The first slice uses repository interfaces with an in-memory implementation for deterministic tests and a PostgreSQL repository implementation aligned with the existing schema/migrations. Conversation/message/event records must survive restart in production mode.

Database additions/verification include:

- conversations
- conversation_participants
- messages
- message_recipients
- agent_sessions
- agent_invocations
- events

Migrations must be idempotent from a clean database state.

## Web stack

Use React + Vite for `apps/web` and a small Fastify API in `apps/api`. Keep the visual design dense and operational: dark/light system theme, clear status chips, transcript-first conversation view, and a network visualization that remains secondary to the textual evidence.

No decorative fake activity. Every displayed message/event must come from backend state.

## Safety

- unknown ACP agents are pending trust
- no shell interpolation when launching local agents
- bounded delegation depth continues across CLI/MCP/ACP paths
- cancellation propagates to active processes/sessions
- public agent metadata is explicitly allowlisted
- permission requests are explicit events and are deny-by-default when no decision path exists
- no credentials or raw environment variables are exposed to the browser
- SSE payloads use canonical sanitized event DTOs

## Acceptance scenario

1. Start Agent2Agent.
2. Existing supported CLI agents are detected.
3. Configured ACP agents are detected and initialized according to trust policy.
4. Open dashboard and see the agent directory.
5. Create a conversation and send `@collective review this project`.
6. One agent sends a message to another through the conversation runtime.
7. Both messages appear live in the dashboard with sender/recipient identity.
8. Send `@codex-local independently review Claude's conclusion` from the dashboard.
9. The directed agent reply appears in the same ordered conversation.
10. Refresh/reconnect and the transcript is reconstructed from persisted state.
11. Agent/tool/session updates are visible as events without leaking credentials or executable paths.
12. A custom ACP endpoint remains pending-trust until explicitly trusted.
