import { EventStore, createMonotonicIdFactory } from "../packages/core/src/index.js";
import {
  ConversationRuntime,
  InMemoryConversationRepository,
} from "../packages/conversation/src/index.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function ok(value: unknown, message = "Expected truthy value"): asserts value { if (!value) throw new Error(message); }

const id = createMonotonicIdFactory("conversation-test");
const events = new EventStore("node-local", id);
const runtime = new ConversationRuntime({
  nodeId: "node-local",
  id,
  events,
  repository: new InMemoryConversationRepository(),
  humanParticipantId: "human:operator",
});

await test("creates a conversation with explicit participants", async () => {
  const conversation = await runtime.create({
    title: "Auth review",
    objective: "Review authentication",
    participantIds: ["claude-local", "codex-local"],
  });

  equal(conversation.status, "created");
  equal(conversation.participantIds, ["human:operator", "claude-local", "codex-local"]);
  ok(events.list("conversation.created").some((event) => event.conversationId === conversation.id));
});

await test("records human messages before routing and parses direct mentions", async () => {
  const conversation = (await runtime.list())[0]!;
  const message = await runtime.sendHumanMessage(conversation.id, {
    text: "@codex-local review this independently",
  });

  equal(message.senderAgentId, "human:operator");
  equal(message.recipientAgentIds, ["codex-local"]);
  equal(message.sequence, 1);
  equal(message.intent, "ask");
  equal(runtime.messages(conversation.id).map((entry) => entry.id), [message.id]);
  const createdIndex = events.list().findIndex((event) => event.type === "message.created" && event.data && typeof event.data === "object" && (event.data as { messageId?: string }).messageId === message.id);
  const routedIndex = events.list().findIndex((event) => event.type === "message.routed" && event.data && typeof event.data === "object" && (event.data as { messageId?: string }).messageId === message.id);
  ok(createdIndex >= 0 && routedIndex > createdIndex, "message.created must precede message.routed");
});

await test("broadcasts unprefixed human messages to the collective", async () => {
  const conversation = (await runtime.list())[0]!;
  const message = await runtime.sendHumanMessage(conversation.id, { text: "work this out together" });
  equal(message.recipientAgentIds, ["claude-local", "codex-local"]);
  equal(message.sequence, 2);
});

await test("records ordered agent replies with identity", async () => {
  const conversation = (await runtime.list())[0]!;
  const message = await runtime.sendAgentMessage(conversation.id, {
    senderAgentId: "codex-local",
    recipientAgentIds: ["claude-local", "human:operator"],
    text: "I found a race condition.",
    intent: "review",
  });
  equal(message.sequence, 3);
  equal(message.senderAgentId, "codex-local");
  equal(runtime.messages(conversation.id).map((entry) => entry.sequence), [1, 2, 3]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} conversation tests failed`);
