import {
  AgentRegistry,
  ConversationEngine,
  EvaluationEngine,
  EventStore,
  HybridMemory,
  InMemoryMemoryProvider,
  SharedIntelligence,
  SwarmRuntime,
  TemporalKnowledgeGraph,
  createMonotonicIdFactory,
  defaultPermissionPolicy,
  type AgentMessage,
  type RegisteredAgent,
} from "../../../packages/core/src/index.js";
import { DeterministicAdapter } from "../../../packages/adapters/src/index.js";
import { WorkspaceCoordinator } from "../../../packages/workspaces/src/index.js";

const id = createMonotonicIdFactory("demo");
const events = new EventStore("node-auckland", id);
const registry = new AgentRegistry(events);

const transcript: string[] = [];
const adapter = new DeterministicAdapter({
  hermes: (_agent, request) => {
    transcript.push(`Hermes: recalled memory for ${request.intent}`);
    return { content: [{ type: "text", text: "Validated pattern: serialize slug allocation with a database lock." }], artifacts: [] };
  },
  codex: () => {
    transcript.push("Codex: reviewed diff and requested a race regression test");
    return { content: [{ type: "text", text: "Add concurrent allocation regression coverage." }], artifacts: [] };
  },
});
registry.registerAdapter(adapter);
for (const entry of [
  makeAgent("coordinator", ["orchestrate"]),
  makeAgent("hermes", ["memory", "research"]),
  makeAgent("claude-code", ["code", "git"]),
  makeAgent("codex", ["review", "code"]),
  makeAgent("opencode", ["test", "code"]),
]) registry.register(entry);

const memoryStore = new InMemoryMemoryProvider(id);
const memory = new HybridMemory(memoryStore);
await memory.ingest({ scope: "project", scopeId: "url-shortener", content: "Validated: PostgreSQL advisory locks prevent duplicate slug allocation under concurrency.", confidence: 0.95, salience: 0.8, usefulness: 0.85, validation: "validated", evidenceIds: ["benchmark:locking-v1"], sourceAgentId: "hermes" });
const recall = await memory.recall({ text: "PostgreSQL concurrency slug locking", allowedScopes: [{ scope: "project", scopeId: "url-shortener" }], limit: 3 });
transcript.push(`Memory: ${recall[0]?.record.content ?? "none"}`);

const workspaces = new WorkspaceCoordinator(".worktrees", id);
const workspace = workspaces.plan("url-shortener", "claude-code", "task-17", "main");
workspaces.transition(workspace.id, "active");
transcript.push(`Workspace: ${workspace.branch} -> ${workspace.worktreePath}`);

const swarm = new SwarmRuntime(registry, events, { maxDepth: 2, maxChildrenPerAgent: 3, maxActiveSubagents: 6, maxSubagentsPerConversation: 6, maxRuntimeSeconds: 120, maxMessagesPerSubagent: 8 }, id);
const specialist = swarm.spawn({ parentAgentId: "claude-code", parentTaskId: "task-17", specialization: "PostgreSQL Specialist", objective: "Review locking semantics", requiredCapabilities: ["database", "concurrency"], maxRuntimeSeconds: 60, maxMessages: 4, maxChildren: 0, workspacePolicy: "shared-read", permissionPolicy: { ...defaultPermissionPolicy(), swarm: { spawn: true, maxChildren: 0 } } }, "conversation-829");
const specialistFinding = swarm.complete(specialist.id, { recommendation: "Use transaction-scoped advisory locking around allocation." });
transcript.push(`Specialist: ${JSON.stringify(specialistFinding)}`);

const conversation = new ConversationEngine(registry, events, { maxRounds: 8, maxMessages: 30, maxConsecutiveAgentTurns: 3 });
const reviewMessage: AgentMessage = { id: id("msg"), conversationId: "conversation-829", senderAgentId: "claude-code", recipientAgentIds: ["codex"], intent: "review", taskId: "task-17", correlationId: id("corr"), round: 2, sequence: 1, content: [{ type: "text", text: "Review URL shortener concurrency diff" }], artifacts: [{ id: "diff-17", kind: "diff", uri: "workspace://task-17/diff" }], routingMetadata: { originNodeId: "node-auckland", currentNodeId: "node-auckland", hopCount: 0, visitedNodeIds: [] }, createdAt: new Date().toISOString() };
await conversation.route(reviewMessage);

workspaces.transition(workspace.id, "review");
workspaces.addReview(workspace.id, { reviewerAgentId: "codex", verdict: "approve", confidence: 0.93, issues: [] });
transcript.push(`Merge gate: ${workspaces.canMerge(workspace.id) ? "ready" : "blocked"}`);

const evaluation = new EvaluationEngine().compare(
  "locking-pattern-v2",
  "locking-pattern-v1",
  "url-shortener-concurrency",
  [{ caseId: "serial", success: true, quality: 0.8, latencyMs: 12 }, { caseId: "concurrent", success: false, quality: 0.4, latencyMs: 25 }],
  [{ caseId: "serial", success: true, quality: 0.82, latencyMs: 13 }, { caseId: "concurrent", success: true, quality: 0.92, latencyMs: 29 }],
);
transcript.push(`Benchmark verdict: ${evaluation.verdict}`);

const intelligence = new SharedIntelligence(events, id);
const knowledge = intelligence.propose({ type: "pattern", title: "Transactional slug allocation", content: "Serialize allocation using transaction-scoped advisory locking and retain a uniqueness constraint as the final invariant.", sourceAgentIds: ["claude-code", "codex", "opencode"], sourceConversationIds: ["conversation-829"], evidenceIds: [], confidence: 0.94, usefulnessScore: 0.85 });
intelligence.validate(knowledge.id, ["benchmark:url-shortener-concurrency"]);
if (evaluation.verdict === "promote") intelligence.promote(knowledge.id);

const graph = new TemporalKnowledgeGraph(id);
graph.addNode(knowledge.id);
graph.addNode("task-17");
graph.link({ sourceId: knowledge.id, targetId: "task-17", relation: "SOLVES", validFrom: new Date().toISOString(), confidence: 0.94, sourceConversationId: "conversation-829", sourceTaskId: "task-17", evidenceIds: ["benchmark:url-shortener-concurrency"] });
transcript.push(`Graph edges for learned pattern: ${graph.neighbors(knowledge.id).length}`);

console.log("Agent2Agent deterministic collective demo");
for (const line of transcript) console.log(`- ${line}`);
console.log(`- Persistable events emitted: ${events.list().length}`);

function makeAgent(agentId: string, capabilities: string[]): RegisteredAgent {
  return { id: agentId, nodeId: "node-auckland", canonicalUri: `a2a://node-auckland/agents/${agentId}`, name: agentId, adapterType: "deterministic", capabilities, status: "idle", ephemeral: false, metadata: {} };
}
