import * as adapters from "../packages/adapters/src/index.js";

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

type ProbeResult = { exitCode: number; stdout: string; stderr: string };
type DiscoveryHost = { locate(executable: string): Promise<string | undefined>; run(executable: string, args: string[]): Promise<ProbeResult> };
type DiscoverFn = (options: { host: DiscoveryHost }) => Promise<Array<Record<string, unknown>>>;

await test("discovers already-configured local CLI agents", async () => {
  const discover = (adapters as unknown as Record<string, unknown>).discoverLocalCliAgents;
  ok(typeof discover === "function", "discoverLocalCliAgents must be exported");
  const paths: Record<string, string | undefined> = { claude: "/usr/bin/claude", codex: "/usr/bin/codex", hermes: "/usr/bin/hermes", opencode: "/usr/bin/opencode", openclaw: undefined };
  const host: DiscoveryHost = {
    async locate(executable) { return paths[executable]; },
    async run(executable, args) {
      if (args.includes("--version")) {
        const versions: Record<string, string> = { claude: "Claude Code 2.1.0", codex: "codex-cli 0.149.0", hermes: "Hermes Agent 0.13.2", opencode: "1.0.180" };
        return { exitCode: 0, stdout: versions[executable] ?? "unknown", stderr: "" };
      }
      if (executable === "claude") return { exitCode: 0, stdout: "logged in", stderr: "" };
      if (executable === "codex") return { exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" };
      if (executable === "hermes") return { exitCode: 0, stdout: "Agent ready", stderr: "" };
      if (executable === "opencode") return { exitCode: 0, stdout: "anthropic\nopenai", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "unsupported" };
    },
  };
  const discovered = await (discover as DiscoverFn)({ host });
  equal(discovered.map((a) => [a.type, a.version, a.authStatus, a.status]), [
    ["claude-code", "2.1.0", "authenticated", "ready"],
    ["codex", "0.149.0", "authenticated", "ready"],
    ["hermes", "0.13.2", "authenticated", "ready"],
    ["opencode", "1.0.180", "authenticated", "ready"],
  ]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} discovery tests failed`);
