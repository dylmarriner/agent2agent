import * as mcp from "../packages/mcp/src/index.js";

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

type BuildCommands = (repoRoot: string) => Record<string, string[]>;

await test("builds safe stdio registration commands for Claude Code and Codex", () => {
  const build = (mcp as unknown as Record<string, unknown>).buildMcpRegistrationCommands;
  ok(typeof build === "function", "buildMcpRegistrationCommands must be exported");
  equal((build as BuildCommands)("/srv/agent 2 agent"), {
    claude: [
      "claude", "mcp", "add", "agent2agent", "--scope", "user", "--",
      "node", "/srv/agent 2 agent/dist/packages/mcp/src/stdio.js",
    ],
    codex: [
      "codex", "mcp", "add", "agent2agent", "--",
      "node", "/srv/agent 2 agent/dist/packages/mcp/src/stdio.js",
    ],
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} MCP registration tests failed`);
