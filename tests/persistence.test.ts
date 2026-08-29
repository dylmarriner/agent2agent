import type { AgentMessage, CollectiveEvent } from "../packages/protocol/src/index.js";
import type { ConversationRecord, UnsequencedAgentMessage } from "../packages/conversation/src/index.js";
import { createMonotonicIdFactory } from "../packages/core/src/index.js";
import {
  DurableEventStore,
  PostgresConversationRepository,
  PostgresEventJournal,
  ensureRuntimeSchema,
  type SqlExecutor,
  type SqlQueryResult,
} from "../packages/database/src/runtime.js";

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

class ScriptedSql implements SqlExecutor {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  private sequence = 0;
  conversationRows: Record<string, unknown>[] = [];
  messageRows: Record<string, unknown>[] = [];
  eventRows: Record<string, unknown>[] = [];

  async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    if (text.includes("RETURNING next_sequence - 1 AS sequence")) {
      this.sequence += 1;
      return { rows: [{ sequence: this.sequence } as Row] };
    }
    if (text.includes("FROM a2a_runtime_conversations") && text.includes("WHERE id =")) return { rows: this.conversationRows as Row[] };
    if (text.includes("FROM a2a_runtime_conversations") && text.includes("ORDER BY created_at")) return { rows: this.conversationRows as Row[] };
    if (text.includes("FROM a2a_runtime_messages") && text.includes("WHERE conversation_id = $1 AND id = $2")) return { rows: this.messageRows as Row[] };
    if (text.includes("FROM a2a_runtime_messages") && text.includes("ORDER BY sequence")) return { rows: this.messageRows as Row[] };
    if (text.includes("FROM a2a_runtime_events")) return { rows: this.eventRows as Row[] };
    return { rows: [] };
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const conversation: ConversationRecord = {
  id: "conversation_local_1",
  nodeId: "local",
  title: "Persistent review",
  objective: "Survive a process restart",
  status: "active",
  participantIds: ["human:operator", "claude-local", "codex-local"],
  createdAt: "2026-08-28T10:00:00.000Z",
  updatedAt: "2026-08-28T10:00:01.000Z",
};

const pendingMessage: UnsequencedAgentMessage = {
  id: "message_local_1",
  conversationId: conversation.id,
  senderAgentId: "human:operator",
  recipientAgentIds: ["claude-local"],
  intent: "ask",
  correlationId: "correlation_local_1",
  round: 0,
  content: [{ type: "text", text: "Persist me" }],
  artifacts: [],
  routingMetadata: { originNodeId: "local", currentNodeId: "local", hopCount: 0, visitedNodeIds: ["local"] },
  createdAt: "2026-08-28T10:00:02.000Z",
};

await test("runtime schema creates text-identity conversation, message and event tables", async () => {
  const sql = new ScriptedSql();
  await ensureRuntimeSchema(sql);
  const ddl = sql.calls.map((call) => call.text).join("\n");
  ok(ddl.includes("a2a_runtime_conversations"));
  ok(ddl.includes("a2a_runtime_messages"));
  ok(ddl.includes("a2a_runtime_events"));
  ok(ddl.includes("sender_participant_id text"));
  ok(ddl.includes("participant_ids jsonb"));
});

await test("conversation repository persists human participants and allocates atomic per-conversation sequences", async () => {
  const sql = new ScriptedSql();
  const repository = new PostgresConversationRepository(sql);
  await repository.saveConversation(conversation);
  const [first, second] = await Promise.all([
    repository.appendMessage(pendingMessage),
    repository.appendMessage({ ...pendingMessage, id: "message_local_2" }),
  ]);
  equal([first.sequence, second.sequence].sort((a, b) => a - b), [1, 2]);
  ok(sql.calls.some((call) => call.text.includes("ON CONFLICT (conversation_id) DO UPDATE")));
  ok(sql.calls.some((call) => call.values.includes("human:operator")));
});

await test("conversation repository reconstructs canonical records without losing lineage", async () => {
  const sql = new ScriptedSql();
  sql.conversationRows = [{
    id: conversation.id,
    node_id: conversation.nodeId,
    title: conversation.title,
    objective: conversation.objective,
    status: conversation.status,
    participant_ids: conversation.participantIds,
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
  }];
  sql.messageRows = [{
    ...rowForMessage({ ...pendingMessage, sequence: 7 }),
    parent_message_id: "message_parent",
    round: 3,
  }];
  const repository = new PostgresConversationRepository(sql);
  equal(await repository.getConversation(conversation.id), conversation);
  const messages = await repository.listMessages(conversation.id);
  equal(messages[0]?.senderAgentId, "human:operator");
  equal(messages[0]?.sequence, 7);
  equal(messages[0]?.parentMessageId, "message_parent");
  equal(messages[0]?.correlationId, pendingMessage.correlationId);
  equal(messages[0]?.round, 3);
});

await test("event journal preserves event order for restart replay", async () => {
  const sql = new ScriptedSql();
  const journal = new PostgresEventJournal(sql);
  const event: CollectiveEvent = {
    id: "evt_local_1",
    type: "message.created",
    nodeId: "local",
    conversationId: conversation.id,
    at: "2026-08-28T10:00:03.000Z",
    data: { messageId: pendingMessage.id },
  };
  await journal.append(event);
  ok(sql.calls.some((call) => call.text.includes("INSERT INTO a2a_runtime_events")));
  sql.eventRows = [{ event_order: 1, id: event.id, type: event.type, node_id: event.nodeId, conversation_id: event.conversationId, task_id: null, agent_id: null, data: event.data, created_at: event.at }];
  equal(await journal.list(), [event]);
});

await test("durable event store hydrates restart history and flushes new events", async () => {
  const historical: CollectiveEvent = {
    id: "evt_persisted_1",
    type: "conversation.started",
    nodeId: "local",
    conversationId: conversation.id,
    at: "2026-08-28T09:59:59.000Z",
    data: { restored: true },
  };
  const persisted: CollectiveEvent[] = [];
  const store = await DurableEventStore.create({
    nodeId: "local",
    id: createMonotonicIdFactory("persist-bridge"),
    journal: {
      async list() { return [historical]; },
      async append(next: CollectiveEvent) { persisted.push(next); },
    },
  });
  equal(store.list(), [historical]);
  const live = store.publish("message.created", { messageId: "live" }, { conversationId: conversation.id });
  await store.flush();
  equal(persisted.map((entry) => entry.id), [live.id]);
  await store.close();
});

function rowForMessage(message: AgentMessage): Record<string, unknown> {
  return {
    id: message.id,
    conversation_id: message.conversationId,
    sender_participant_id: message.senderAgentId,
    recipient_participant_ids: message.recipientAgentIds,
    intent: message.intent,
    task_id: message.taskId ?? null,
    parent_message_id: message.parentMessageId ?? null,
    correlation_id: message.correlationId,
    round: message.round,
    sequence: message.sequence,
    content: message.content,
    artifacts: message.artifacts,
    routing_metadata: message.routingMetadata,
    created_at: message.createdAt,
  };
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} persistence tests failed`);
