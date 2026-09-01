import { createControlPlaneRuntime } from "../apps/api/src/runtime.js";
import { createMonotonicIdFactory } from "../packages/core/src/index.js";
import { DurableEventStore } from "../packages/database/src/durable-events.js";
import {
  PostgresConversationRepository,
  PostgresEventJournal,
  type PgRuntimeDatabase,
  type SqlExecutor,
  type SqlQueryResult,
} from "../packages/database/src/runtime.js";
import type { CollectiveEvent } from "../packages/protocol/src/index.js";

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

class RecordingSql implements SqlExecutor {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  eventRows: Record<string, unknown>[] = [];
  conversationRows: Record<string, unknown>[] = [];

  async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    if (text.includes("FROM a2a_runtime_events")) return { rows: this.eventRows as Row[] };
    if (text.includes("FROM a2a_runtime_conversations")) return { rows: this.conversationRows as Row[] };
    return { rows: [] };
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> { return fn(this); }
}

class FakeRuntimeDatabase extends RecordingSql implements PgRuntimeDatabase {
  closeCalls = 0;
  failEventWrites = false;

  override async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    if (this.failEventWrites && text.includes("INSERT INTO a2a_runtime_events")) throw new Error("journal unavailable");
    return super.query<Row>(text, values);
  }

  async close(): Promise<void> { this.closeCalls += 1; }
}

await test("durable publish queues persistence even when a subscriber throws", async () => {
  const persisted: CollectiveEvent[] = [];
  const store = await DurableEventStore.create({
    nodeId: "node-a",
    id: createMonotonicIdFactory("durable-subscriber"),
    journal: {
      async list() { return []; },
      async append(event) { persisted.push(event); },
    },
  });
  store.subscribe(() => { throw new Error("subscriber exploded"); });
  let threw = false;
  try { store.publish("message.created", { messageId: "m1" }); }
  catch { threw = true; }
  ok(threw, "subscriber failure should still propagate to the publisher");
  await store.flush();
  equal(persisted.length, 1);
  await store.close();
});

await test("event replay is node-scoped and requests the newest bounded window", async () => {
  const sql = new RecordingSql();
  const journal = new PostgresEventJournal(sql, "node-a");
  await journal.list(25);
  const call = sql.calls.at(-1);
  ok(call);
  ok(/node_id\s*=\s*\$1/i.test(call.text), "event replay must filter by node_id");
  ok(/ORDER BY\s+event_order\s+DESC/i.test(call.text), "inner replay query must choose newest events first");
  ok(/ORDER BY\s+event_order\s+ASC/i.test(call.text), "bounded replay must be returned chronologically");
  equal(call.values, ["node-a", 25]);
});

await test("conversation reads are scoped to the owning node", async () => {
  const sql = new RecordingSql();
  const repository = new PostgresConversationRepository(sql, "node-a");
  await repository.getConversation("conversation-1");
  await repository.listConversations();
  const reads = sql.calls.filter((call) => call.text.includes("FROM a2a_runtime_conversations"));
  equal(reads.length, 2);
  for (const call of reads) {
    ok(/node_id\s*=\s*\$/i.test(call.text), "conversation reads must include a node_id predicate");
    ok(call.values.includes("node-a"), "conversation reads must bind the current node id");
  }
});

await test("caller-owned runtime databases remain open after runtime shutdown", async () => {
  const database = new FakeRuntimeDatabase();
  const runtime = await createControlPlaneRuntime({
    nodeId: "node-owned-test",
    autoInstall: false,
    enableAcp: false,
    runtimeDatabase: database,
    env: { AGENT2AGENT_NODE_ID: "node-owned-test" },
  });
  await runtime.close();
  equal(database.closeCalls, 0);
});

await test("standalone runtime closes its owned database when later startup validation fails", async () => {
  const database = new FakeRuntimeDatabase();
  let threw = false;
  try {
    await createControlPlaneRuntime({
      nodeId: "node-startup-failure",
      autoInstall: false,
      enableAcp: false,
      runtimeDatabaseFactory: () => database,
      env: {
        AGENT2AGENT_NODE_ID: "node-startup-failure",
        DATABASE_URL: "postgres://test/agent2agent",
        AGENT2AGENT_MAX_CONVERSATION_HOPS: "0",
      },
    });
  } catch { threw = true; }
  ok(threw, "invalid runtime limits must fail startup");
  equal(database.closeCalls, 1);
});

await test("standalone runtime closes its owned database even when durable flush fails", async () => {
  const database = new FakeRuntimeDatabase();
  const runtime = await createControlPlaneRuntime({
    nodeId: "node-close-failure",
    autoInstall: false,
    enableAcp: false,
    runtimeDatabaseFactory: () => database,
    env: {
      AGENT2AGENT_NODE_ID: "node-close-failure",
      DATABASE_URL: "postgres://test/agent2agent",
    },
  });
  database.failEventWrites = true;
  runtime.events.publish("message.created", { messageId: "must-fail-flush" });
  let threw = false;
  try { await runtime.close(); }
  catch { threw = true; }
  ok(threw, "durability failure must be surfaced to the caller");
  equal(database.closeCalls, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} durability regression tests failed`);
