import { A2A_PROTOCOL_VERSION, type AgentCard } from "@a2a-js/sdk";
import { DeterministicAdapter } from "../packages/adapters/src/index.js";
import { AgentRegistry, EventStore, createMonotonicIdFactory } from "../packages/core/src/index.js";
import { ConversationDispatcher } from "../packages/conversation/src/dispatcher.js";
import { ConversationRuntime, InMemoryConversationRepository } from "../packages/conversation/src/index.js";
import { buildApiServer, type ControlPlaneRuntime } from "../apps/api/src/server.js";
import { resolveAdvertisedA2aBaseUrl } from "../apps/api/src/a2a.js";

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
function throws(fn: () => unknown, pattern: RegExp): void {
  try { fn(); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) throw error;
    return;
  }
  throw new Error(`Expected throw matching ${pattern}`);
}

function makeRuntime(): ControlPlaneRuntime {
  const nodeId = "a2a-production";
  const id = createMonotonicIdFactory(nodeId);
  const events = new EventStore(nodeId, id);
  const registry = new AgentRegistry(events);
  const adapter = new DeterministicAdapter({});
  registry.registerAdapter(adapter);
  registry.register({
    id: "agent-local",
    nodeId,
    canonicalUri: `a2a://${nodeId}/agents/agent-local`,
    name: "Agent Local",
    adapterType: adapter.type,
    capabilities: ["review"],
    status: "idle",
    ephemeral: false,
    metadata: { trustStatus: "trusted", transportTypes: ["cli"] },
  });
  const conversations = new ConversationRuntime({ nodeId, id, events, repository: new InMemoryConversationRepository() });
  const dispatcher = new ConversationDispatcher({ registry, conversations, events });
  return {
    nodeId,
    startedAt: new Date().toISOString(),
    events,
    registry,
    conversations,
    dispatcher,
    persistence: "memory",
    async trustAgent(agentId) { return registry.get(agentId); },
    async close() { await dispatcher.close(); },
  };
}

await test("production server exposes a public Agent Card and bearer-protected A2A endpoint", async () => {
  const runtime = makeRuntime();
  const app = buildApiServer(runtime, {
    apiToken: "federation-secret",
    a2aBaseUrl: "https://node.example/federation/",
  });

  const cardResponse = await app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
  equal(cardResponse.statusCode, 200);
  const card = cardResponse.json<AgentCard>();
  equal(card.supportedInterfaces[0]?.url, "https://node.example/federation/a2a");
  equal(card.supportedInterfaces[0]?.protocolVersion, A2A_PROTOCOL_VERSION);
  equal(card.securitySchemes.agent2agentBearer?.scheme?.$case, "httpAuthSecurityScheme");
  equal(card.securityRequirements[0]?.schemes.agent2agentBearer?.list, []);

  const unauthenticated = await app.inject({
    method: "POST",
    url: "/a2a",
    payload: { jsonrpc: "2.0", id: "probe", method: "UnsupportedMethod", params: {} },
  });
  equal(unauthenticated.statusCode, 401);

  const authenticated = await app.inject({
    method: "POST",
    url: "/a2a",
    headers: { authorization: "Bearer federation-secret", "a2a-version": A2A_PROTOCOL_VERSION },
    payload: { jsonrpc: "2.0", id: "probe", method: "UnsupportedMethod", params: {} },
  });
  equal(authenticated.statusCode, 200);
  ok(authenticated.json<{ jsonrpc?: string }>().jsonrpc === "2.0");

  await app.close();
  await runtime.close();
});

await test("advertised A2A base URLs never publish wildcard bind addresses", () => {
  equal(resolveAdvertisedA2aBaseUrl("127.0.0.1", 8787), "http://127.0.0.1:8787");
  equal(resolveAdvertisedA2aBaseUrl("::1", 8787), "http://[::1]:8787");
  equal(resolveAdvertisedA2aBaseUrl("0.0.0.0", 8787, "https://a2a.example"), "https://a2a.example");
  throws(() => resolveAdvertisedA2aBaseUrl("0.0.0.0", 8787), /public|advertised|AGENT2AGENT_A2A_BASE_URL/i);
  throws(() => resolveAdvertisedA2aBaseUrl("::", 8787), /public|advertised|AGENT2AGENT_A2A_BASE_URL/i);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} A2A production tests failed`);
