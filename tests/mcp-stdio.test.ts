import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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

await test("compiled MCP stdio server negotiates the current protocol and serves collective tools", async () => {
  const serverPath = resolve(process.cwd(), "dist/packages/mcp/src/stdio.js");
  const client = new Client(
    { name: "agent2agent-test-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );

  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
    equal(client.getNegotiatedProtocolVersion(), "2026-07-28");

    const { tools } = await client.listTools();
    equal(tools.map((tool) => tool.name), ["list_agents", "find_agent", "ask_agent"]);

    const result = await client.callTool({ name: "list_agents", arguments: {} });
    ok(result.isError !== true, `list_agents failed: ${JSON.stringify(result.content)}`);
    ok(result.structuredContent && typeof result.structuredContent === "object", "list_agents must return structuredContent");
    const agents = (result.structuredContent as { agents?: unknown }).agents;
    ok(Array.isArray(agents), "list_agents structuredContent.agents must be an array");
  } finally {
    await client.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} MCP stdio tests failed`);
