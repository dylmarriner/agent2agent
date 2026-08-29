import { AgentRegistry, EventStore, createMonotonicIdFactory } from "../packages/core/src/index.js";
import { DeterministicAdapter } from "../packages/adapters/src/index.js";
import { ConversationDispatcher } from "../packages/conversation/src/dispatcher.js";
import { ConversationRuntime, InMemoryConversationRepository } from "../packages/conversation/src/index.js";
import { buildApiServer, type ControlPlaneRuntime } from "../apps/api/src/server.js";
import type { RegisteredAgent } from "../packages/protocol/src/index.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(value: unknown, message = "Expected truthy value"): asserts value { if (!value) throw new Error(message); }

function makeRuntime(): ControlPlaneRuntime {
  const nodeId = "node-api-test";
  const id = createMonotonicIdFactory("api-test");
  const events = new EventStore(nodeId, id);
  const registry = new AgentRegistry(events);
  const adapter = new DeterministicAdapter({
    "claude-local": async (_agent, request) => ({
      content: [{ type: "text", text: `Claude received: ${request.content[0]?.type === "text" ? request.content[0].text : ""}` }],
      artifacts: [],
    }),
    "codex-local": async (_agent, request) => ({
      content: [{ type: "text", text: `Codex received: ${request.content[0]?.type === "text" ? request.content[0].text : ""}` }],
      artifacts: [],
    }),
  });
  registry.registerAdapter(adapter);
  const register = (agent: Omit<RegisteredAgent, "nodeId" | "canonicalUri" | "adapterType" | "capabilities" | "status" | "ephemeral"> & { id: string; name: string; metadata: Record<string, unknown> }): void => {
    registry.register({
      id: agent.id,
      nodeId,
      canonicalUri: `a2a://${nodeId}/agents/${agent.id}`,
      name: agent.name,
      adapterType: "deterministic",
      capabilities: ["ask", "review"],
      status: "idle",
      ephemeral: false,
      metadata: agent.metadata,
    });
  };
  register({ id: "claude-local", name: "Claude Local", metadata: { transportTypes: ["cli", "mcp"], trustStatus: "trusted", executablePath: "/secret/bin/claude" } });
  register({ id: "codex-local", name: "Codex Local", metadata: { transportTypes: ["cli", "acp"], trustStatus: "trusted", executablePath: "/secret/bin/codex" } });

  const conversations = new ConversationRuntime({
    nodeId,
    id,
    events,
    repository: new InMemoryConversationRepository(),
    humanParticipantId: "human:operator",
  });
  const dispatcher = new ConversationDispatcher({ registry, conversations, events });

  return {
    nodeId,
    startedAt: new Date().toISOString(),
    events,
    registry,
    conversations,
    dispatcher,
    persistence: "memory",
    async trustAgent(agentId, trustStatus) {
      const agent = registry.get(agentId);
      return {
        ...agent,
        status: trustStatus === "trusted" ? "idle" : "degraded",
        metadata: { ...agent.metadata, trustStatus },
      };
    },
    async close() { await dispatcher.close(); },
  };
}

await test("health and agent endpoints expose sanitized runtime state", async () => {
  const runtime = makeRuntime();
  const app = buildApiServer(runtime);
  const health = await app.inject({ method: "GET", url: "/api/v1/system/health" });
  equal(health.statusCode, 200);
  equal(health.json().nodeId, runtime.nodeId);

  const agents = await app.inject({ method: "GET", url: "/api/v1/agents" });
  equal(agents.statusCode, 200);
  const body = agents.json() as { agents: Array<Record<string, unknown>> };
  equal(body.agents.map((agent) => agent.id), ["claude-local", "codex-local"]);
  ok(!JSON.stringify(body).includes("/secret/bin"), "public agent DTO must not expose executable paths");
  equal(body.agents[0]?.transportTypes, ["cli", "mcp"]);
  equal(body.agents[0]?.trustStatus, "trusted");
  await app.close();
  await runtime.close();
});

await test("creates conversations and dispatches human messages through real adapters", async () => {
  const runtime = makeRuntime();
  const app = buildApiServer(runtime);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/conversations",
    payload: { title: "Auth review", objective: "Work together", participantIds: ["claude-local", "codex-local"] },
  });
  equal(created.statusCode, 201);
  const conversationId = (created.json() as { conversation: { id: string } }).conversation.id;

  const sent = await app.inject({
    method: "POST",
    url: `/api/v1/conversations/${conversationId}/messages`,
    payload: { text: "@claude-local inspect this" },
  });
  equal(sent.statusCode, 202);
  const sentBody = sent.json() as { message: { senderAgentId: string }; produced: Array<{ senderAgentId: string }> };
  equal(sentBody.message.senderAgentId, "human:operator");
  equal(sentBody.produced.map((message) => message.senderAgentId), ["claude-local"]);

  const transcript = await app.inject({ method: "GET", url: `/api/v1/conversations/${conversationId}/messages` });
  equal((transcript.json() as { messages: Array<{ senderAgentId: string }> }).messages.map((message) => message.senderAgentId), ["human:operator", "claude-local"]);
  await app.close();
  await runtime.close();
});

await test("event replay and one-shot SSE preserve event ids and order", async () => {
  const runtime = makeRuntime();
  runtime.events.publish("conversation.started", { source: "test" }, { conversationId: "conv-test" });
  const events = runtime.events.list();
  const cursor = events.at(-2)?.id;
  ok(cursor);
  const app = buildApiServer(runtime);

  const replay = await app.inject({ method: "GET", url: `/api/v1/events?after=${encodeURIComponent(cursor)}` });
  const replayBody = replay.json() as { events: Array<{ id: string }> };
  equal(replayBody.events.map((event) => event.id), [events.at(-1)!.id]);

  const stream = await app.inject({ method: "GET", url: `/api/v1/events/stream?after=${encodeURIComponent(cursor)}&once=1` });
  equal(stream.statusCode, 200);
  ok(stream.headers["content-type"]?.includes("text/event-stream"));
  ok(stream.body.includes(`id: ${events.at(-1)!.id}`));
  ok(stream.body.includes("event: conversation.started"));
  await app.close();
  await runtime.close();
});

await test("trust endpoint delegates trust transition to the runtime", async () => {
  const runtime = makeRuntime();
  const app = buildApiServer(runtime);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agents/claude-local/trust",
    payload: { trustStatus: "disabled" },
  });
  equal(response.statusCode, 200);
  equal((response.json() as { agent: { trustStatus: string; status: string } }).agent.trustStatus, "disabled");
  equal((response.json() as { agent: { trustStatus: string; status: string } }).agent.status, "degraded");
  await app.close();
  await runtime.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} API tests failed`);
