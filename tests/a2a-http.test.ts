import Fastify from "fastify";
import { A2A_PROTOCOL_VERSION, Role, SendMessageRequest, type AgentCard } from "@a2a-js/sdk";
import { registerA2aRoutes } from "../apps/api/src/a2a.js";
import { DeterministicAdapter } from "../packages/adapters/src/index.js";
import { AgentRegistry, EventStore, createMonotonicIdFactory } from "../packages/core/src/index.js";
import { ConversationDispatcher } from "../packages/conversation/src/dispatcher.js";
import { ConversationRuntime, InMemoryConversationRepository } from "../packages/conversation/src/index.js";

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

function makeRuntime() {
  const nodeId = "node-http-a2a";
  const id = createMonotonicIdFactory("http-a2a");
  const events = new EventStore(nodeId, id);
  const registry = new AgentRegistry(events);
  const adapter = new DeterministicAdapter({
    "codex-local": async (_agent, request) => ({
      content: [{ type: "text", text: `Codex checked: ${request.content[0]?.type === "text" ? request.content[0].text : ""}` }],
      artifacts: [],
    }),
  });
  registry.registerAdapter(adapter);
  registry.register({
    id: "codex-local", nodeId, canonicalUri: `a2a://${nodeId}/agents/codex-local`, name: "Codex Local",
    adapterType: adapter.type, capabilities: ["review", "test"], status: "idle", ephemeral: false,
    metadata: { trustStatus: "trusted", transportTypes: ["cli", "mcp"] },
  });
  const conversations = new ConversationRuntime({ nodeId, id, events, repository: new InMemoryConversationRepository() });
  const dispatcher = new ConversationDispatcher({ registry, conversations, events });
  return { nodeId, events, registry, conversations, dispatcher };
}

await test("Fastify serves a current Agent Card and accepts official A2A JSON-RPC", async () => {
  const runtime = makeRuntime();
  const app = Fastify({ logger: false });
  registerA2aRoutes(app, runtime, { baseUrl: "http://127.0.0.1:8787" });

  const cardResponse = await app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
  equal(cardResponse.statusCode, 200);
  const card = cardResponse.json<AgentCard>();
  equal(card.supportedInterfaces[0]?.protocolVersion, A2A_PROTOCOL_VERSION);
  ok(card.skills.some((skill) => skill.id === "agent:codex-local"));

  const request: SendMessageRequest = {
    tenant: "",
    message: {
      role: Role.ROLE_USER,
      messageId: "wire-message-1",
      contextId: "wire-context-1",
      taskId: "wire-task-1",
      parts: [{ content: { $case: "text", value: "Review the auth patch" }, mediaType: "text/plain", filename: "", metadata: {} }],
      metadata: { "agent2agent.peerId": "wire-peer", "agent2agent.targetAgentIds": ["codex-local"], "agent2agent.intent": "review" },
      extensions: [], referenceTaskIds: [],
    },
    configuration: { acceptedOutputModes: ["text"], returnImmediately: false, taskPushNotificationConfig: undefined },
    metadata: {},
  };
  const rpcResponse = await app.inject({
    method: "POST",
    url: "/a2a",
    headers: { "a2a-version": A2A_PROTOCOL_VERSION },
    payload: { jsonrpc: "2.0", id: "req-1", method: "SendMessage", params: SendMessageRequest.toJSON(request) },
  });
  equal(rpcResponse.statusCode, 200);
  const rpc = rpcResponse.json<{ id: string; result?: { task?: { id?: string; contextId?: string } }; error?: unknown }>();
  equal(rpc.id, "req-1");
  equal(rpc.error, undefined);
  equal(rpc.result?.task?.id, "wire-task-1");
  equal(rpc.result?.task?.contextId, "wire-context-1");
  const transcript = await runtime.conversations.messages("a2a:wire-context-1");
  equal(transcript.map((message) => message.senderAgentId), ["a2a:wire-peer", "codex-local"]);

  await runtime.dispatcher.close();
  await app.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} A2A HTTP tests failed`);
