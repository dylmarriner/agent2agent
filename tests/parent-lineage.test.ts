import { readFile } from "node:fs/promises";
import { RUNTIME_SCHEMA_SQL } from "../packages/database/src/runtime.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}

function ok(value: unknown, message = "Expected truthy value"): asserts value { if (!value) throw new Error(message); }

function normalized(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

await test("fresh runtime schema constrains parent messages to the same conversation", () => {
  const sql = normalized(RUNTIME_SCHEMA_SQL);
  ok(/unique\s*\(\s*conversation_id\s*,\s*id\s*\)/i.test(sql), "messages need a composite conversation/id unique key");
  ok(
    /foreign key\s*\(\s*conversation_id\s*,\s*parent_message_id\s*\)\s*references\s+a2a_runtime_messages\s*\(\s*conversation_id\s*,\s*id\s*\)/i.test(sql),
    "parent lineage must use a same-conversation composite foreign key",
  );
  ok(!/parent_message_id\s+text\s+references\s+a2a_runtime_messages\s*\(\s*id\s*\)/i.test(sql), "single-column parent FK must be removed");
});

await test("upgrade migration replaces the existing single-column parent foreign key", async () => {
  const path = new URL("../packages/database/migrations/0003_same_conversation_lineage.sql", import.meta.url);
  const migration = normalized(await readFile(path, "utf8"));
  ok(migration.includes("unique (conversation_id, id)"), "upgrade must add the composite unique key");
  ok(migration.includes("foreign key (conversation_id, parent_message_id)"), "upgrade must add composite parent FK");
  ok(migration.includes("references a2a_runtime_messages(conversation_id, id)"), "composite parent FK must target the same conversation");
  ok(/drop constraint/i.test(migration), "upgrade must remove the pre-existing single-column parent FK");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} parent-lineage tests failed`);
