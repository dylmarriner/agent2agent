import { readFile } from "node:fs/promises";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}
function ok(value: unknown, message = "Expected truthy value"): asserts value { if (!value) throw new Error(message); }

await test("web control center is wired to canonical API and SSE rather than mock transcripts", async () => {
  const [app, api, conversation, directory, graph] = await Promise.all([
    readFile("apps/web/src/app.tsx", "utf8"),
    readFile("apps/web/src/api.ts", "utf8"),
    readFile("apps/web/src/components/ConversationViewer.tsx", "utf8"),
    readFile("apps/web/src/components/AgentDirectory.tsx", "utf8"),
    readFile("apps/web/src/components/NetworkGraph.tsx", "utf8"),
  ]);
  ok(api.includes("/api/v1/agents"));
  ok(api.includes("/api/v1/conversations"));
  ok(api.includes("/api/v1/events/stream"));
  ok(api.includes("EventSource"));
  ok(conversation.includes("@collective"));
  ok(directory.includes("trustStatus"));
  ok(graph.includes("recipientAgentIds"));
  const combined = [app, api, conversation, directory, graph].join("\n").toLowerCase();
  ok(!combined.includes("mockmessages"), "dashboard must not contain mock transcript data");
  ok(!combined.includes("fakemessages"), "dashboard must not contain fake transcript data");
});

await test("dashboard has explicit agent, transcript, graph and composer surfaces", async () => {
  const app = await readFile("apps/web/src/app.tsx", "utf8");
  ok(app.includes("AgentDirectory"));
  ok(app.includes("ConversationViewer"));
  ok(app.includes("NetworkGraph"));
  ok(app.includes("CreateConversation"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} web static tests failed`);
