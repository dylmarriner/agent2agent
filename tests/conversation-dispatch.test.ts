import { DeterministicAdapter } from "../packages/adapters/src/index.js";
import { ConversationDispatcher } from "../packages/conversation/src/dispatcher.js";
import { ConversationRuntime, InMemoryConversationRepository } from "../packages/conversation/src/index.js";
import { AgentRegistry, EventStore, createMonotonicIdFactory } from "../packages/core/src/index.js";

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

function buildHarness() {
  const id = createMonotonicIdFactory("dispatch");
  const events = new EventStore("node-local", id);
  const registry = new AgentRegistry(events);
  const calls: string[] = [];
  const adapter = new DeterministicAdapter({
    "claude-local": async (_agent, request) => {
      const text = request.content.find((part) => part.type === "text")?.text ?? "";
      calls.push(`claude:${text}`);
      return { content: [{ type: "text", text: "@codex-local Please independently verify the race condition." }], artifacts: [] };
    },
    "codex-local": async (_agent, request) => {
      const text = request.content.find((part) => part.type === "text")?.text ?? "";
      calls.push(`codex:${text}`);
      return { content: [{ type: "text", text: "Confirmed. The race condition is real." }], artifacts: [] };
    },
  });
  registry.registerAdapter(adapter);
  for (const [idValue, name] of [["claude-local", "Claude"], ["codex-local", "Codex"]] as const) {
    registry.register({
      id: idValue,
      nodeId: "node-local",
      canonicalUri: `a2a://node-local/agents/${idValue}`,
      name,
      adapterType: "deterministic",
      capabilities: ["ask", "review"],
      status: "idle",
      ephemeral: false,
      metadata: {},
    });
  }
  const conversations = new ConversationRuntime({
    nodeId: "node-local",
    id,
    events,
    repository: new InMemoryConversationRepository(),
  });
  const dispatcher = new ConversationDispatcher({ registry, conversations, events, maxAgentHops: 4 });
  return { calls, conversations, dispatcher, events };
}

await test("routes explicit agent mentions as real follow-up turns in one conversation", async () => {
  const { calls, conversations, dispatcher } = buildHarness();
  const conversation = await conversations.create({ title: "Race review", objective: "Find concurrency bugs", participantIds: ["claude-local", "codex-local"] });
  const human = await conversations.sendHumanMessage(conversation.id, { text: "@claude-local review this implementation" });
  await dispatcher.dispatch(human);

  const transcript = await conversations.messages(conversation.id);
  equal(transcript.map((message) => [message.senderAgentId, message.recipientAgentIds, message.sequence]), [
    ["human:operator", ["claude-local"], 1],
    ["claude-local", ["codex-local"], 2],
    ["codex-local", ["claude-local"], 3],
  ]);
  equal(calls.length, 2);
  ok(calls[0]?.startsWith("claude:"));
  ok(calls[1]?.startsWith("codex:"));
});

await test("ordinary agent replies are recorded but do not recurse indefinitely", async () => {
  const { calls, conversations, dispatcher } = buildHarness();
  const conversation = await conversations.create({ title: "Direct", objective: "Ask Codex", participantIds: ["claude-local", "codex-local"] });
  const human = await conversations.sendHumanMessage(conversation.id, { text: "@codex-local check this" });
  await dispatcher.dispatch(human);
  equal(calls.length, 1);
  const transcript = await conversations.messages(conversation.id);
  equal(transcript.at(-1)?.recipientAgentIds, ["human:operator"]);
});

await test("refuses dispatch beyond configured agent hop limit", async () => {
  const { conversations, events } = buildHarness();
  const registry = new AgentRegistry(events);
  const loop = new DeterministicAdapter({
    a: () => ({ content: [{ type: "text", text: "@b continue" }], artifacts: [] }),
    b: () => ({ content: [{ type: "text", text: "@a continue" }], artifacts: [] }),
  });
  registry.registerAdapter(loop);
  for (const id of ["a", "b"]) registry.register({ id, nodeId: "node-local", canonicalUri: `a2a://node-local/agents/${id}`, name: id, adapterType: "deterministic", capabilities: ["ask"], status: "idle", ephemeral: false, metadata: {} });
  const dispatcher = new ConversationDispatcher({ registry, conversations, events, maxAgentHops: 2 });
  const conversation = await conversations.create({ title: "Loop", objective: "Bound loop", participantIds: ["a", "b"] });
  const human = await conversations.sendHumanMessage(conversation.id, { text: "@a start" });
  let rejected = false;
  try { await dispatcher.dispatch(human); } catch (error) { rejected = String(error).includes("hop limit"); }
  equal(rejected, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} conversation dispatch tests failed`);
