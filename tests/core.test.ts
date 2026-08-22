import {
  AgentRegistry,
  ConversationEngine,
  EvaluationEngine,
  EventStore,
  FederationGuard,
  HybridMemory,
  InMemoryMemoryProvider,
  SharedIntelligence,
  SwarmRuntime,
  TaskDag,
  TemporalKnowledgeGraph,
  CollectiveError,
  createMonotonicIdFactory,
  defaultPermissionPolicy,
  type AgentMessage,
  type FederationEnvelope,
  type RegisteredAgent,
  type TaskRecord,
} from "../packages/core/src/index.js";
import { DeterministicAdapter } from "../packages/adapters/src/index.js";
import { ExpertRouter } from "../packages/orchestration/src/index.js";
import { WorkspaceCoordinator } from "../packages/workspaces/src/index.js";
import { PermissionEngine, assertSafeHttpTarget } from "../packages/security/src/index.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(error);
  }
}

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function ok(value: unknown, message = "Expected truthy value"): asserts value {
  if (!value) throw new Error(message);
}

async function rejects(fn: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    throw new Error(`Expected rejection ${code}`);
  } catch (error) {
    if (!(error instanceof CollectiveError) || error.code !== code) throw error;
  }
}

const id = createMonotonicIdFactory("test");
const events = new EventStore("test-node", id);

await test("agent registry enforces adapter registration", () => {
  const registry = new AgentRegistry(events);
  const adapter = new DeterministicAdapter({});
  registry.registerAdapter(adapter);
  registry.register(agent("builder", "deterministic", ["code"]));
  equal(registry.list("code").map((entry) => entry.id), ["builder"]);
});

await test("task DAG exposes only dependency-satisfied tasks", () => {
  const dag = new TaskDag(events);
  const now = new Date().toISOString();
  const a = task("a", [], now);
  const b = task("b", ["a"], now);
  dag.add(a);
  dag.add(b);
  equal(dag.ready().map((entry) => entry.id), ["a"]);
  dag.transition("a", "completed");
  equal(dag.ready().map((entry) => entry.id), ["b"]);
});

await test("swarm runtime enforces child limits and cleans up ephemeral identities", async () => {
  const registry = new AgentRegistry(events);
  registry.registerAdapter(new DeterministicAdapter({}));
  registry.register(agent("parent", "deterministic", ["code"]));
  const swarm = new SwarmRuntime(registry, events, { maxDepth: 2, maxChildrenPerAgent: 1, maxActiveSubagents: 2, maxSubagentsPerConversation: 2, maxRuntimeSeconds: 60, maxMessagesPerSubagent: 5 }, id);
  const request = {
    parentAgentId: "parent",
    parentTaskId: "t1",
    specialization: "database",
    objective: "check locking",
    maxRuntimeSeconds: 30,
    maxMessages: 3,
    maxChildren: 2,
    workspacePolicy: "isolated-worktree" as const,
    permissionPolicy: defaultPermissionPolicy(),
  };
  const child = swarm.spawn(request, "c1");
  await rejects(() => swarm.spawn(request, "c1"), "swarm_children_limit");
  swarm.complete(child.id, { finding: "use advisory lock" });
  equal(registry.list().map((entry) => entry.id), ["parent"]);
});

await test("hybrid memory survives optional provider outage and keeps scope isolation", async () => {
  const fallback = new InMemoryMemoryProvider(id);
  const hybrid = new HybridMemory(fallback, [{ name: "stg", available: async () => true, recall: async () => { throw new Error("offline"); } }]);
  await hybrid.ingest({ scope: "project", scopeId: "repo-a", content: "Use PostgreSQL advisory locks for serialized slug allocation", confidence: 0.9, salience: 0.8, usefulness: 0.7, validation: "validated", evidenceIds: ["test-1"] });
  await hybrid.ingest({ scope: "project", scopeId: "repo-b", content: "Secret from another project", confidence: 1, salience: 1, usefulness: 1, validation: "validated", evidenceIds: [] });
  const results = await hybrid.recall({ text: "PostgreSQL locking", allowedScopes: [{ scope: "project", scopeId: "repo-a" }] });
  equal(results.length, 1);
  ok(results[0]?.record.content.includes("advisory locks"));
});

await test("temporal graph respects validity windows", () => {
  const graph = new TemporalKnowledgeGraph(id);
  graph.addNode("solution");
  graph.addNode("task");
  const edge = graph.link({ sourceId: "solution", targetId: "task", relation: "SOLVES", validFrom: "2026-01-01T00:00:00.000Z", evidenceIds: ["e1"] });
  equal(graph.neighbors("solution", "2026-02-01T00:00:00.000Z").length, 1);
  graph.close(edge.id, "2026-03-01T00:00:00.000Z");
  equal(graph.neighbors("solution", "2026-04-01T00:00:00.000Z").length, 0);
});

await test("shared intelligence cannot promote unvalidated claims", async () => {
  const knowledge = new SharedIntelligence(events, id);
  const item = knowledge.propose({ type: "pattern", title: "Lock before allocate", content: "Serialize allocation transactionally", sourceAgentIds: ["tester"], sourceConversationIds: ["c1"], evidenceIds: [], confidence: 0.8, usefulnessScore: 0.6 });
  await rejects(() => knowledge.promote(item.id), "knowledge_not_validated");
  knowledge.validate(item.id, ["passing-regression-test"]);
  equal(knowledge.promote(item.id).validationStatus, "validated");
});

await test("benchmark engine rejects pass-to-fail regression", () => {
  const result = new EvaluationEngine().compare("candidate", "baseline", "suite", [{ caseId: "race", success: true, quality: 0.8, latencyMs: 20 }], [{ caseId: "race", success: false, quality: 0.9, latencyMs: 15 }]);
  equal(result.verdict, "reject");
  equal(result.regressions[0]?.severity, "high");
});

await test("federation guard blocks replay and loops", async () => {
  const guard = new FederationGuard("node-b");
  const envelope: FederationEnvelope = { id: "env", originNodeId: "node-a", destinationNodeId: "node-b", visitedNodeIds: ["node-a"], hopCount: 1, maxHops: 3, correlationId: "corr", nonce: "nonce-1", sentAt: new Date().toISOString(), payload: {} };
  guard.validate(envelope);
  await rejects(() => guard.validate(envelope), "federation_replay");
  await rejects(() => guard.validate({ ...envelope, nonce: "nonce-2", visitedNodeIds: ["node-a", "node-b"] }), "federation_loop");
});

await test("conversation engine rejects duplicate messages", async () => {
  const registry = new AgentRegistry(events);
  registry.registerAdapter(new DeterministicAdapter({ reviewer: () => ({ content: [{ type: "text", text: "approved" }], artifacts: [] }) }));
  registry.register(agent("builder", "deterministic", ["code"]));
  registry.register(agent("reviewer", "deterministic", ["review"]));
  const engine = new ConversationEngine(registry, events, { maxRounds: 3, maxMessages: 5, maxConsecutiveAgentTurns: 2 });
  const message = messageFixture();
  await engine.route(message);
  await rejects(() => engine.route({ ...message, id: "msg-2", sequence: 2 }), "duplicate_message");
});

await test("workspace coordinator requires review before merge", () => {
  const coordinator = new WorkspaceCoordinator(".worktrees", id);
  const workspace = coordinator.plan("repo", "Claude Code", "task-17", "abc123");
  coordinator.transition(workspace.id, "review");
  equal(coordinator.canMerge(workspace.id), false);
  coordinator.addReview(workspace.id, { reviewerAgentId: "codex", verdict: "approve", issues: [], confidence: 0.95 });
  equal(coordinator.canMerge(workspace.id), true);
});

await test("expert router combines evidence and trust", () => {
  const router = new ExpertRouter();
  const ranked = router.rank("security", [
    { agent: agent("a", "deterministic", ["security"]), available: true, trust: 0.5, memoryRelevance: 0.2, workspaceLocality: 1, federationLatencyScore: 1, permissionFit: 1, capabilityScore: { agentId: "a", capability: "security", successRate: 0.6, qualityScore: 0.6, latencyScore: 1, sampleCount: 50, confidence: 0.9 } },
    { agent: agent("b", "deterministic", ["security"]), available: true, trust: 0.9, memoryRelevance: 0.9, workspaceLocality: 1, federationLatencyScore: 0.8, permissionFit: 1, capabilityScore: { agentId: "b", capability: "security", successRate: 0.95, qualityScore: 0.9, latencyScore: 0.8, sampleCount: 100, confidence: 0.98 } },
  ]);
  equal(ranked[0]?.agent.id, "b");
});

await test("permission and SSRF guards deny unapproved access", async () => {
  const engine = new PermissionEngine();
  const policy = defaultPermissionPolicy();
  await rejects(() => engine.assertNetwork(policy, "example.com"), "network_denied");
  await rejects(() => assertSafeHttpTarget(new URL("http://127.0.0.1/admin")), "ssrf_private");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} tests failed`);

function agent(id: string, adapterType: string, capabilities: string[]): RegisteredAgent {
  return { id, nodeId: "test-node", canonicalUri: `a2a://test-node/agents/${id}`, name: id, adapterType, capabilities, status: "idle", ephemeral: false, metadata: {} };
}

function task(idValue: string, dependencyIds: string[], now: string): TaskRecord {
  return { id: idValue, conversationId: "c1", title: idValue, objective: idValue, status: "pending", reviewerAgentIds: [], dependencyIds, attempt: 0, maxAttempts: 2, createdAt: now, updatedAt: now };
}

function messageFixture(): AgentMessage {
  return { id: "msg-1", conversationId: "c1", senderAgentId: "builder", recipientAgentIds: ["reviewer"], intent: "review", correlationId: "corr", round: 1, sequence: 1, content: [{ type: "text", text: "review this" }], artifacts: [], routingMetadata: { originNodeId: "test-node", currentNodeId: "test-node", hopCount: 0, visitedNodeIds: [] }, createdAt: new Date().toISOString() };
}
