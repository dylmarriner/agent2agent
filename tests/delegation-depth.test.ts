import { LocalAuthenticatedCliAdapter, productAdapters } from "../packages/adapters/src/index.js";
import type { RegisteredAgent } from "../packages/protocol/src/index.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

await test("local CLI adapter propagates Agent2Agent delegation depth to nested MCP hosts", async () => {
  const calls: Array<{ env: Record<string, string | undefined> }> = [];
  const adapter = new LocalAuthenticatedCliAdapter(productAdapters["claude-code"]!, async (input) => {
    calls.push(input);
    return { exitCode: 0, stdout: JSON.stringify({ result: "ok", session_id: "session-1" }), stderr: "" };
  });
  const agent: RegisteredAgent = {
    id: "claude-local",
    nodeId: "local",
    canonicalUri: "a2a://local/agents/claude-local",
    name: "Claude Local",
    adapterType: "claude-code",
    capabilities: ["ask"],
    status: "idle",
    ephemeral: false,
    metadata: {},
  };
  const session = await adapter.createSession(agent, { conversationId: "c1" });
  await adapter.send(
    session,
    { intent: "ask", content: [{ type: "text", text: "delegate" }] },
    { conversationId: "c1", metadata: { agent2agentDelegationDepth: 2 } },
  );
  equal(calls.length, 1);
  equal(calls[0]?.env.AGENT2AGENT_DELEGATION_DEPTH, "2");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} delegation depth tests failed`);
