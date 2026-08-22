# Agent2Agent: Phased Roadmap to 100% Production Completion

## Purpose

This document defines the implementation path required to take **Agent2Agent from its current foundation to 100% of the intended federated collective-intelligence platform**.

The target is not simply to have multiple agents installed or callable. At 100%, a user must be able to open an already configured CLI agent such as Claude Code, Codex, Hermes, or OpenCode and work normally while that agent can securely communicate with the wider Agent2Agent collective, delegate work, request reviews, use memory, spawn specialists, collaborate through isolated Git workspaces, and use remote agents when appropriate.

Completion is measured by **working behaviour and test evidence**, not by the number of folders, interfaces, or unfinished abstractions in the repository.

---

# Current Baseline

The current implementation provides the beginning of the Agent2Agent kernel:

- Canonical agent and collaboration protocol.
- Agent registry and adapter architecture.
- Core task and conversation runtime.
- Bounded swarm controls.
- Scoped memory abstractions.
- Temporal knowledge graph foundation.
- Shared-intelligence and benchmark concepts.
- Workspace and review primitives.
- Federation safety primitives.
- PostgreSQL/pgvector initial schema.
- Deterministic model-free testing.
- Local Claude Code integration using the user's existing CLI authentication.
- Local Codex integration using the user's existing CLI authentication.
- Existing CLI credentials remain owned by each CLI rather than copied into Agent2Agent.

The major missing piece between the current state and the intended experience is the **live collective control plane connecting already configured CLI agents to one another**.

The roadmap below closes that gap systematically.

---

# Phase 1: Local CLI Agent Discovery and Runtime

**Target contribution to completion: 8%**

Agent2Agent must automatically discover supported CLI agents already configured on the machine.

Supported initial agents:

- Claude Code
- Codex
- Hermes
- OpenCode
- OpenClaw where a local control interface is available

Discovery must determine:

- Whether the binary exists.
- Executable path.
- Installed version.
- Authentication status where safely detectable.
- Supported structured-output mode.
- Session/resume support.
- MCP support.
- A2A support.
- Working-directory support.
- Streaming support.
- Tool capabilities.
- Whether the runtime is currently healthy.

Agent2Agent must **never require the user to enter an API key merely because a supported CLI agent is already authenticated locally**.

### Acceptance gate

A clean Agent2Agent installation can scan the machine and produce a registry resembling:

```text
Claude Code
Status: Ready
Authentication: Existing CLI session
Sessions: Supported
MCP: Supported
Workspace execution: Supported

Codex
Status: Ready
Authentication: Existing ChatGPT/Codex login
Threads: Supported
Structured events: Supported
Workspace execution: Supported

Hermes
Status: Ready
Authentication: Managed by Hermes
MCP: Supported
Memory: Supported

OpenCode
Status: Ready
Sessions: Supported
JSON execution: Supported
Server mode: Supported
```

No provider credential duplication is required.

---

# Phase 2: Collective MCP Gateway

**Target cumulative completion: 18%**

Build the MCP server that turns Agent2Agent into a tool available directly inside compatible CLI agents.

Initial tools must include:

```text
list_agents
find_agent
ask_agent

create_conversation
send_message

delegate_task
get_task
wait_for_task

request_review
request_test
request_research

spawn_specialist

search_memory
search_shared_knowledge
search_knowledge_graph

create_workspace
get_diff
request_code_review

list_remote_nodes
delegate_remote_task
```

This phase creates the interaction Dylan actually wants:

```text
Dylan
  ↓
Claude Code
  ↓
Agent2Agent MCP
  ↓
Codex / Hermes / OpenCode / specialists
  ↓
Agent2Agent
  ↓
Claude Code
  ↓
Dylan
```

Claude, Codex, Hermes and other clients should not need modifications to their source code when MCP already gives us the required extension point.

### Acceptance gate

From an ordinary existing Claude Code session:

```text
Review this project and ask Codex for an independent architecture review.
```

Claude can discover and invoke Agent2Agent's tools, Agent2Agent invokes the locally authenticated Codex agent, and Codex's response returns to Claude.

No API key is manually supplied to Agent2Agent.

---

# Phase 3: Bidirectional Agent Communication

**Target cumulative completion: 26%**

Agents must stop being simple subprocesses and become participants in structured conversations.

Implement:

```text
Agent → Agent
Agent → Multiple agents
Agent → Specialist
Agent → Remote agent
Agent → Human escalation

Task → Agent
Review → Agent
Result → Parent agent
```

Every message must retain:

```text
sender
recipient
conversation
task
intent
correlation ID
sequence
round
artifacts
external session/thread IDs
timestamps
```

Communication must support:

```text
ask
delegate
research
review
critique
verify
test
debug
challenge
compare
teach
synthesize
vote
```

### Acceptance gate

The following interaction works without manual intervention:

```text
Claude → Hermes
Search collective memory for previous solutions.

Hermes → Claude
Three relevant patterns found.

Claude → Codex
Review the approach.

Codex → Claude
Found a race condition.

Claude → OpenCode
Reproduce Codex's concern.

OpenCode → Claude
Confirmed. Test attached.

Claude
Fixes implementation.
```

The entire exchange is persisted as structured state.

---

# Phase 4: Task DAG and Intelligent Orchestration

**Target cumulative completion: 35%**

Introduce the full distributed task graph.

Each objective can be decomposed into:

```text
research
planning
implementation
testing
review
security review
integration
documentation
verification
```

Support orchestration strategies:

```text
directed
parallel
expert-router
ensemble
debate
review-loop
task-graph
swarm
federated
manual
```

Routing must consider evidence rather than agent names alone.

Scoring should include:

```text
capability
historical success
quality
latency
availability
cost
workspace locality
permissions
memory relevance
benchmark evidence
federation latency
```

### Acceptance gate

Given:

```text
Implement secure distributed authentication.
```

the coordinator can autonomously construct and execute a DAG such as:

```text
Research → Hermes

Architecture → Claude

Implementation → Claude
                  ├─ Database specialist
                  └─ Security specialist

Independent review → Codex

Reproduction/tests → OpenCode

Final synthesis → Claude
```

Dependencies, retries and status survive a process restart.

---

# Phase 5: Swarm Runtime and Temporary Specialists

**Target cumulative completion: 42%**

Enable agents to create temporary specialists dynamically.

Examples:

```text
PostgreSQL concurrency specialist
Cryptography reviewer
TypeScript performance specialist
Kubernetes specialist
Security specialist
Test specialist
Protocol specialist
```

A specialist inherits only the permissions it requires.

Every subagent must have:

```text
parent
objective
specialization
capabilities
permissions
budget
runtime limit
message limit
workspace
result contract
termination reason
```

Hard controls must include:

```text
maximum swarm depth
maximum children
maximum active specialists
maximum runtime
maximum cost
maximum tokens
loop prevention
permission inheritance
workspace isolation
```

### Acceptance gate

Claude can recognize that a database-locking question needs expertise, spawn a temporary PostgreSQL specialist, receive its findings, incorporate them into its parent task and terminate the specialist cleanly.

Exponential subagent spawning must be impossible under configured policy.

---

# Phase 6: Real Git Multi-Agent Workspace Collaboration

**Target cumulative completion: 53%**

This is one of the most important engineering phases.

Every coding agent receives an isolated Git worktree.

Example:

```text
main

.worktrees/
  claude/task-41
  codex/task-42
  opencode/task-43
```

Never allow two agents to mutate one working tree concurrently.

Implement:

```text
branch-per-task
worktree-per-agent
workspace locks
diff capture
changed-file classification
test execution
review requests
merge queue
rebase/update
conflict detection
conflict reconciliation
cleanup
```

### Acceptance gate

Claude, Codex and OpenCode can modify the same repository simultaneously without corrupting one another's work.

A complete coding workflow succeeds:

```text
Task assigned
↓
Worktree created
↓
Agent changes code
↓
Diff captured
↓
Tests run
↓
Codex reviews Claude
↓
OpenCode independently tests
↓
Required gates pass
↓
Merge queue accepts
↓
Branch rebased
↓
Controlled merge
```

No original branch is destroyed during conflict reconciliation.

---

# Phase 7: Persistent Hybrid Memory and SCOS

**Target cumulative completion: 62%**

Build the complete collective-memory pipeline.

PostgreSQL remains authoritative.

Memory retrieval combines:

```text
PostgreSQL records
PostgreSQL full-text search
pgvector semantic similarity
SCOS/STG associative recall
temporal graph relationships
recent task memory
workspace memory
project memory
agent-specific memory
validated shared knowledge
```

Memory scopes:

```text
turn
task
conversation
agent
workspace
project
organization
collective
```

SCOS/STG remains optional through a `CognitiveMemoryProvider`.

If SCOS fails:

```text
Agent2Agent continues operating.
```

Memory must distinguish:

```text
truth/confidence
salience
usefulness
recency
validation
```

Retrieval frequency must never automatically make a claim more truthful.

### Acceptance gate

A solution learned during one conversation can be recalled appropriately during a later related conversation.

The UI/API can explain:

```text
what memory was returned
why it was returned
where it came from
what evidence supports it
whether it has been superseded
how useful it has historically been
```

---

# Phase 8: Shared Intelligence and Temporal Knowledge Graph

**Target cumulative completion: 70%**

Transform isolated memories into governed collective knowledge.

Represent:

```text
facts
patterns
solutions
failures
warnings
strategies
procedures
skills
```

Every reusable item must have:

```text
source
evidence
confidence
validation status
usefulness
provenance
history
```

Implement relationships such as:

```text
AGENT → SOLVED → TASK

AGENT → REVIEWED → REVISION

SOLUTION → SOLVES → PROBLEM

SOLUTION → FAILED_ON → CONDITION

MEMORY → SUPPORTED_BY → EVIDENCE

MEMORY → CONTRADICTS → MEMORY

MEMORY → SUPERSEDES → MEMORY

SKILL → DERIVED_FROM → CONVERSATION
```

### Acceptance gate

The collective remembers both:

```text
What worked.
```

and:

```text
What failed, under what conditions, and why.
```

A newer validated solution can supersede an older one without deleting its history.

---

# Phase 9: Benchmark-Driven Autonomous Improvement

**Target cumulative completion: 78%**

Agent2Agent can become more effective, but it must not become an uncontrolled self-modifying system.

Candidates may modify:

```text
prompts
routing policies
memory retrieval
skills
agent configuration
orchestration
workflow selection
shared knowledge
review policies
```

Every candidate follows:

```text
Candidate
↓
Offline benchmark
↓
Baseline comparison
↓
Regression analysis
↓
Cost/latency analysis
↓
Peer review
↓
Canary
↓
Production
```

Deployment states:

```text
draft
candidate
canary
production
retired
```

### Acceptance gate

A proposed routing strategy that performs better than the baseline is promoted.

A different candidate that improves one metric but causes a serious regression is automatically rejected.

Rollback to the previous production version succeeds.

---

# Phase 10: Federated Agent Mesh

**Target cumulative completion: 86%**

Multiple Agent2Agent servers must collaborate.

Example:

```text
Home Agent2Agent node
        │
        ├──── Local Claude
        ├──── Local Codex
        ├──── Hermes
        │
        ▼
Remote Agent2Agent node
        │
        ├──── GPU agents
        ├──── Security agents
        └──── Other specialists
```

Implement:

```text
peer discovery
signed node identity
mTLS
trust policies
capability exchange
remote delegation
remote events
remote skill lookup
selected knowledge sharing
rate limits
anti-replay
hop limits
visited-node tracking
```

### Acceptance gate

Two independent Agent2Agent nodes can connect securely.

An agent on Node A can:

```text
discover an allowed capability on Node B
delegate work
receive streamed progress
receive the result
retain provenance
```

Routing loops are prevented.

---

# Phase 11: Marketplace and Reusable Skills

**Target cumulative completion: 91%**

Create the local package ecosystem.

Supported package types:

```text
agent
adapter
skill
workflow
orchestration strategy
memory provider
benchmark
evaluation policy
tool
```

Packages require manifests specifying:

```text
name
version
publisher
compatibility
entrypoint
capabilities
permissions
integrity
```

Support:

```text
inspect
install
enable
disable
update
pin
rollback
remove
```

Executable packages run outside the main API process wherever possible.

### Acceptance gate

A new security-review workflow can be installed from a local path or Git repository, its permissions inspected, enabled, executed, rolled back and removed without destabilizing Agent2Agent core.

---

# Phase 12: Production Control Center

**Target cumulative completion: 96%**

Build the full operational UI.

Required areas:

```text
Dashboard

Agents
Conversations
Task Graph
Swarm

Repositories
Workspaces
Diff Review
Merge Queue

Memory
SCOS Explorer
Knowledge Graph
Shared Intelligence
Skills

Marketplace

Benchmarks
Evaluations
Promotions

Federation
Remote Nodes
Network Topology

Events
Metrics
System Health
Settings
```

The network graph should visibly display:

```text
agents
subagents
messages
delegations
reviews
memory links
workspace operations
federation
errors
```

### Acceptance gate

An operator can understand what the collective is doing without opening log files or querying the database manually.

Every important autonomous action has visible provenance.

---

# Phase 13: Distributed Runtime, Security and Observability

**Target cumulative completion: 99%**

Productionize the execution infrastructure.

Implement:

```text
Fastify API/control plane
Redis distributed queue
BullMQ or equivalent workers
PostgreSQL
pgvector
distributed locks
leases
idempotency
dead-letter queues
cancellation
per-agent concurrency
workspace locks
```

Security must enforce:

```text
authentication
authorization
filesystem boundaries
shell permissions
network allowlists
SSRF protection
secret isolation
credential references
payload limits
rate limits
audit logging
redaction
artifact scanning hooks
federation trust
marketplace permissions
```

Observability:

```text
OpenTelemetry
Prometheus
structured logs
distributed traces
health endpoints
```

Deployment:

```text
Docker Compose
Kubernetes
Helm
HPA
PDB
NetworkPolicy
readiness
liveness
resource limits
```

### Acceptance gate

Restarting API or worker processes does not lose conversation or task state.

Multiple workers can process jobs concurrently without violating ordering, task ownership or workspace isolation.

Metrics and traces expose the complete path:

```text
Human
→ CLI agent
→ MCP
→ Agent2Agent
→ Task
→ Worker
→ Remote/local agent
→ Memory
→ Review
→ Result
```

---

# Phase 14: Final 100% Validation

**Target cumulative completion: 100%**

No feature receives credit merely because code exists.

The final validation starts from a clean checkout.

Run:

```text
dependency installation
typecheck
lint
unit tests
integration tests
end-to-end tests

fresh database migration

API startup
worker startup
web startup

Redis coordination
PostgreSQL persistence

local Claude authentication integration
local Codex authentication integration
Hermes integration
OpenCode integration
OpenClaw integration

MCP
A2A

agent discovery
agent-to-agent messaging
delegation
reviews

swarm spawning
swarm limits
specialist result merging

Git worktree isolation
parallel coding
diff review
merge queue
conflict reconciliation

memory ingestion
semantic retrieval
SCOS retrieval
SCOS failure fallback

knowledge graph
shared intelligence
superseding information

benchmark evaluation
candidate promotion
regression rejection
rollback

marketplace install
permission enforcement
package update
package rollback

two-node federation
remote discovery
remote delegation
streaming
loop protection

pause
resume
stop
cancellation

restart persistence

OpenTelemetry
Prometheus

Docker Compose

Kubernetes validation
```

The project reaches **100% only when every required behaviour has evidence showing it works**.

---

# Mandatory End-to-End Acceptance Scenario

The final system must successfully perform this scenario from an already configured CLI agent.

```text
Dylan opens Claude Code normally.

Dylan:
Build a rate-limited URL shortener.
Use the collective where it improves the result.

Claude:
Creates collective objective.

Claude → Hermes:
Search memory for relevant previous solutions.

Hermes → Shared Memory / SCOS:
Retrieves validated concurrency and caching patterns.

Claude:
Creates isolated Git workspace.

Claude:
Implements the service.

Claude:
Spawns PostgreSQL specialist.

Specialist:
Reviews locking strategy.

Claude → Codex:
Perform independent code review.

Codex:
Finds concurrency problem.

Claude → OpenCode:
Reproduce Codex's finding independently.

OpenCode:
Reproduces issue and creates failing test.

Claude:
Applies fix.

OpenCode:
Tests pass.

Codex:
Approves revised diff.

Memory Curator:
Creates candidate reusable locking pattern.

Knowledge Engine:
Links evidence and provenance.

Benchmark Engine:
Evaluates candidate against existing pattern.

Benchmark:
Candidate improves pass rate without regression.

Knowledge Engine:
Promotes candidate.

Remote Agent2Agent node:
Advertises security-review capability.

Claude → Remote security agent:
Perform final review.

Remote agent:
Returns approved review.

Merge Queue:
All gates pass.

Workspace Manager:
Merges implementation.

Claude:
Reports completed objective back to Dylan.
```

At the end:

```text
Conversation persisted.
Messages persisted.
Tasks persisted.
Subagent visible.
Worktrees isolated.
Tests recorded.
Reviews recorded.
Merge recorded.
Memory updated.
Knowledge graph updated.
Learning evaluated.
Remote task recorded.
Everything survives restart.
```

---

# Definition of the User Experience at 100%

The final experience should be simple.

Dylan should not need to become the orchestrator manually.

He opens whichever CLI agent he wants:

```bash
claude
```

or:

```bash
codex
```

or:

```bash
hermes
```

and communicates normally.

Behind that agent sits:

```text
                Dylan
                  │
                  ▼
            Primary CLI Agent
                  │
                  ▼
             Agent2Agent
                  │
       ┌──────────┼───────────┐
       ▼          ▼           ▼
    Claude      Codex       Hermes
       │          │           │
       ├──── OpenCode ────────┤
       │                      │
       ├── Specialists        │
       │                      │
       └──── Remote Nodes ────┘
                  │
                  ▼
              SCOS Memory
                  │
                  ▼
         Shared Intelligence
```

The primary agent should remain the user's interface.

Agent2Agent becomes the invisible coordination system underneath it.

The user should be able to say:

```text
Build this properly and use whatever agents you think will improve it.
```

The system should then determine:

```text
whether collaboration is necessary
which agents are useful
what they should do
whether specialists are required
which work can run in parallel
what memory is relevant
who should review the work
what tests are required
whether results disagree
how disagreements should be resolved
whether something learned is worth retaining
whether any improvement actually beats the baseline
```

That is the point at which Agent2Agent stops being a collection of integrations and becomes a genuine **collective intelligence operating system**.

---

# Execution Rule

We should complete these phases sequentially, but not rigidly.

Every phase must end with:

```text
implementation
↓
typecheck
↓
lint
↓
unit tests
↓
integration tests
↓
relevant end-to-end test
↓
fix failures
↓
Conventional Commit
↓
next phase
```

No phase is marked complete while critical behaviour remains mocked unless the external integration genuinely cannot be executed in CI.

Where third-party credentials, binaries or remote infrastructure are unavailable, the repository must contain:

```text
real adapter
mock transport
fixtures
automated tests
setup documentation
optional live integration tests
```

The standard throughout the project is simple:

**working evidence over apparent progress.**
