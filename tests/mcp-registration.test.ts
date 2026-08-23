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
type CommandResult = { exitCode: number; stdout: string; stderr: string };
type CommandExecutor = (command: string, args: string[]) => Promise<CommandResult>;
type InstallHosts = (options: { repoRoot: string; hosts: Array<"claude" | "codex">; execute: CommandExecutor }) => Promise<Record<string, CommandResult>>;

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

await test("installs selected MCP hosts without a shell and returns each result", async () => {
  const install = (mcp as unknown as Record<string, unknown>).installMcpHosts;
  ok(typeof install === "function", "installMcpHosts must be exported");
  const calls: Array<[string, string[]]> = [];
  const execute: CommandExecutor = async (command, args) => {
    calls.push([command, args]);
    return { exitCode: 0, stdout: `${command}:ok`, stderr: "" };
  };
  const result = await (install as InstallHosts)({ repoRoot: "/srv/agent 2 agent", hosts: ["claude", "codex"], execute });
  equal(calls, [
    ["claude", ["mcp", "add", "agent2agent", "--scope", "user", "--", "node", "/srv/agent 2 agent/dist/packages/mcp/src/stdio.js"]],
    ["codex", ["mcp", "add", "agent2agent", "--", "node", "/srv/agent 2 agent/dist/packages/mcp/src/stdio.js"]],
  ]);
  equal(result, {
    claude: { exitCode: 0, stdout: "claude:ok", stderr: "" },
    codex: { exitCode: 0, stdout: "codex:ok", stderr: "" },
  });
});

await test("host installation stops and surfaces a failed registration", async () => {
  const install = (mcp as unknown as Record<string, unknown>).installMcpHosts;
  ok(typeof install === "function", "installMcpHosts must be exported");
  const calls: string[] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command);
    return command === "claude"
      ? { exitCode: 1, stdout: "", stderr: "already exists" }
      : { exitCode: 0, stdout: "ok", stderr: "" };
  };
  let message = "";
  try {
    await (install as InstallHosts)({ repoRoot: "/repo", hosts: ["claude", "codex"], execute });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  equal(calls, ["claude"]);
  equal(message, "Failed to register Agent2Agent MCP with claude: already exists");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} MCP registration tests failed`);
