import { DeterministicAdapter } from "../packages/adapters/src/index.js";
import { AgentRegistry, EventStore, createMonotonicIdFactory } from "../packages/core/src/index.js";
import { ConversationRuntime, InMemoryConversationRepository } from "../packages/conversation/src/index.js";
import { ConversationDispatcher } from "../packages/conversation/src/dispatcher.js";
import { buildApiServer, type ControlPlaneRuntime } from "../apps/api/src/server.js";
import { assertSecureControlPlaneBind } from "../apps/api/src/security.js";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function throws(fn: () => void, pattern: RegExp): void {
  try { fn(); } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!pattern.test(text)) throw error;
    return;
  }
  throw new Error(`Expected throw matching ${pattern}`);
}

function runtime(): ControlPlaneRuntime {
  const nodeId = "auth-test";
  const id = createMonotonicIdFactory("auth-test");
  const events = new EventStore(nodeId, id);
  const registry = new AgentRegistry(events);
  const adapter = new DeterministicAdapter({});
  registry.registerAdapter(adapter);
  registry.register({
    id: "agent-local",
    nodeId,
    canonicalUri: `a2a://${nodeId}/agents/agent-local`,
    name: "Agent Local",
    adapterType: "deterministic",
    capabilities: ["ask"],
    status: "idle",
    ephemeral: false,
    metadata: { trustStatus: "trusted" },
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
    async trustAgent(agentId) { return registry.get(agentId); },
    async close() { await dispatcher.close(); },
  };
}

await test("configured API token protects HTTP and SSE endpoints", async () => {
  const rt = runtime();
  const app = buildApiServer(rt, { apiToken: "top-secret-token" });
  equal((await app.inject({ method: "GET", url: "/api/v1/agents" })).statusCode, 401);
  equal((await app.inject({ method: "GET", url: "/api/v1/agents", headers: { authorization: "Bearer wrong" } })).statusCode, 401);
  equal((await app.inject({ method: "GET", url: "/api/v1/agents", headers: { authorization: "Bearer top-secret-token" } })).statusCode, 200);
  equal((await app.inject({ method: "GET", url: "/api/v1/events/stream?once=1", headers: { authorization: "Bearer top-secret-token" } })).statusCode, 200);
  await app.close();
  await rt.close();
});

await test("non-loopback control-plane binds require authentication", () => {
  assertSecureControlPlaneBind("127.0.0.1", undefined);
  assertSecureControlPlaneBind("::1", undefined);
  assertSecureControlPlaneBind("0.0.0.0", "token");
  throws(() => assertSecureControlPlaneBind("0.0.0.0", undefined), /token|authentication|loopback/i);
  throws(() => assertSecureControlPlaneBind("192.168.1.50", ""), /token|authentication|loopback/i);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} API auth tests failed`);
