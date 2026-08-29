import { AcpAgentAdapter, type AcpConnector } from "../packages/acp/src/index.js";
import { discoverAcpEndpoints } from "../packages/acp/src/discovery.js";
import { EventStore, createMonotonicIdFactory } from "../packages/core/src/index.js";
import { ConversationRuntime, InMemoryConversationRepository } from "../packages/conversation/src/index.js";
import { ConversationDispatcher } from "../packages/conversation/src/dispatcher.js";
import type { AgentAdapter, AgentSession, RegisteredAgent } from "../packages/protocol/src/index.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function rejects(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try { await fn(); } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!pattern.test(text)) throw error;
    return;
  }
  throw new Error(`Expected rejection matching ${pattern}`);
}

await test("custom ACP endpoints cannot collide with known canonical identities", async () => {
  const host = {
    async locate(executable: string) {
      if (executable === "hermes") return "/usr/bin/hermes";
      if (executable === "custom-acp") return "/opt/custom-acp";
      return undefined;
    },
    async run() { return { exitCode: 0, stdout: "ready", stderr: "" }; },
  };
  await rejects(() => discoverAcpEndpoints({
    host,
    customEndpoints: [{ id: "hermes-acp", type: "custom", command: "custom-acp" }],
  }), /duplicate|collision|reserved/i);
});

await test("ACP session creation failure closes its unregistered connection", async () => {
  let closed = 0;
  const connector: AcpConnector = async () => ({
    capabilities: { loadSession: false },
    async newSession() { throw new Error("session failed"); },
    async prompt() { return { stopReason: "end_turn", text: "unused" }; },
    async cancel() {},
    async close() { closed += 1; },
  });
  const adapter = new AcpAgentAdapter({ id: "test-acp", type: "test", command: "test", args: [], trustStatus: "trusted" }, connector);
  const agent: RegisteredAgent = { id: "test-local", nodeId: "local", canonicalUri: "a2a://local/agents/test-local", name: "Test", adapterType: "acp", capabilities: ["ask"], status: "idle", ephemeral: false, metadata: {} };
  await rejects(() => adapter.createSession(agent, { conversationId: "conv" }), /session failed/);
  equal(closed, 1);
});

await test("already-aborted ACP requests never start a prompt", async () => {
  let promptCalls = 0;
  const connector: AcpConnector = async () => ({
    capabilities: { loadSession: false },
    async newSession() { return "vendor-session"; },
    async prompt() { promptCalls += 1; return { stopReason: "end_turn", text: "unused" }; },
    async cancel() {},
    async close() {},
  });
  const adapter = new AcpAgentAdapter({ id: "test-acp", type: "test", command: "test", args: [], trustStatus: "trusted" }, connector);
  const agent: RegisteredAgent = { id: "test-local", nodeId: "local", canonicalUri: "a2a://local/agents/test-local", name: "Test", adapterType: "acp", capabilities: ["ask"], status: "idle", ephemeral: false, metadata: {} };
  const session = await adapter.createSession(agent, { conversationId: "conv" });
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await rejects(() => adapter.send(session, { intent: "ask", content: [{ type: "text", text: "hello" }] }, { conversationId: "conv", signal: controller.signal }), /stop|abort/i);
  equal(promptCalls, 0);
});

await test("secondary human IDs do not satisfy the required agent participant", async () => {
  const events = new EventStore("local", createMonotonicIdFactory("human-regression"));
  const conversations = new ConversationRuntime({ nodeId: "local", id: createMonotonicIdFactory("human-regression"), events, repository: new InMemoryConversationRepository() });
  await rejects(() => conversations.create({ title: "Humans only", objective: "No agent", participantIds: ["human:other"] }), /non-human participant/i);
});

await test("concurrent dispatches share one in-flight session for the same conversation and agent", async () => {
  const events = new EventStore("local", createMonotonicIdFactory("session-regression"));
  const id = createMonotonicIdFactory("session-regression");
  const conversations = new ConversationRuntime({ nodeId: "local", id, events, repository: new InMemoryConversationRepository() });
  const conversation = await conversations.create({ title: "Concurrent", objective: "Share a session", participantIds: ["agent-a"] });
  let creates = 0;
  const adapter: AgentAdapter = {
    type: "test",
    async discover() { return { capabilities: ["ask"], supportsStreaming: false, supportsSessions: true, supportsCancellation: true, supportsTools: false }; },
    async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
    async createSession(agent): Promise<AgentSession> {
      creates += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { id: `session-${creates}`, agentId: agent.id, createdAt: new Date().toISOString() };
    },
    async send() { return { content: [{ type: "text", text: "done" }], artifacts: [] }; },
    async terminateSession() {},
  };
  const agent: RegisteredAgent = { id: "agent-a", nodeId: "local", canonicalUri: "a2a://local/agents/agent-a", name: "Agent A", adapterType: "test", capabilities: ["ask"], status: "idle", ephemeral: false, metadata: {} };
  const registry = { get: () => agent, adapterFor: () => adapter };
  const dispatcher = new ConversationDispatcher({ registry, conversations, events, maxActiveSessions: 2 });
  const first = await conversations.sendHumanMessage(conversation.id, { text: "@agent-a first" });
  const second = await conversations.sendHumanMessage(conversation.id, { text: "@agent-a second" });
  await Promise.all([dispatcher.dispatch(first), dispatcher.dispatch(second)]);
  equal(creates, 1);
  await dispatcher.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} control-center regression tests failed`);
