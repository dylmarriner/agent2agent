import * as adapters from "../packages/adapters/src/index.js";
import { AgentRegistry, EventStore, createMonotonicIdFactory } from "../packages/core/src/index.js";
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
function ok(value: unknown, message = "Expected truthy value"): asserts value { if (!value) throw new Error(message); }

type ProbeResult = { exitCode: number; stdout: string; stderr: string };
type DiscoveryHost = { locate(executable: string): Promise<string | undefined>; run(executable: string, args: string[]): Promise<ProbeResult> };
type DiscoverFn = (options: { host: DiscoveryHost }) => Promise<Array<Record<string, unknown>>>;
type RegisterFn = (options: { registry: AgentRegistry; nodeId: string; host: DiscoveryHost }) => Promise<RegisteredAgent[]>;

function configuredHost(): DiscoveryHost {
  const paths: Record<string, string | undefined> = {
    claude: "/usr/bin/claude",
    codex: "/usr/bin/codex",
    hermes: "/usr/bin/hermes",
    opencode: "/usr/bin/opencode",
    openclaw: "/usr/bin/openclaw",
    agy: "/usr/bin/agy",
    copilot: "/usr/bin/copilot",
    goose: "/usr/bin/goose",
  };
  return {
    async locate(executable) { return paths[executable]; },
    async run(executable, args) {
      const name = executable.split(/[\\/]/).at(-1) ?? executable;
      if (args.includes("--version")) {
        const versions: Record<string, string> = {
          claude: "Claude Code 2.1.0",
          codex: "codex-cli 0.149.0",
          hermes: "Hermes Agent 0.13.2",
          opencode: "1.0.180",
          openclaw: "OpenClaw 2026.8.0",
          agy: "Antigravity CLI 1.1.13",
          copilot: "1.12.0",
          goose: "goose 1.21.0",
        };
        return { exitCode: 0, stdout: versions[name] ?? "unknown", stderr: "" };
      }
      if (name === "claude") return { exitCode: 0, stdout: "logged in", stderr: "" };
      if (name === "codex") return { exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" };
      if (name === "hermes") return { exitCode: 0, stdout: "Agent ready", stderr: "" };
      if (name === "opencode") return { exitCode: 0, stdout: "anthropic\nopenai", stderr: "" };
      if (name === "openclaw") return { exitCode: 0, stdout: JSON.stringify({ ok: true, gateway: { status: "ready" } }), stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "unsupported" };
    },
  };
}

await test("discovers configured local CLI and ACP-capable agents", async () => {
  const discover = (adapters as unknown as Record<string, unknown>).discoverLocalCliAgents;
  ok(typeof discover === "function", "discoverLocalCliAgents must be exported");
  const discovered = await (discover as DiscoverFn)({ host: configuredHost() });
  equal(discovered.map((a) => [
    a.type,
    a.version,
    a.authStatus,
    a.status,
    a.transportTypes,
    a.trustStatus,
    a.supportsAcp,
    a.supportsMcp,
  ]), [
    ["claude-code", "2.1.0", "authenticated", "ready", ["cli", "mcp"], "trusted", false, true],
    ["codex", "0.149.0", "authenticated", "ready", ["cli", "mcp"], "trusted", false, true],
    ["hermes", "0.13.2", "authenticated", "ready", ["cli", "mcp", "acp"], "trusted", true, true],
    ["opencode", "1.0.180", "authenticated", "ready", ["cli", "mcp"], "trusted", false, true],
    ["openclaw", "2026.8.0", "authenticated", "ready", ["cli"], "trusted", false, false],
    ["antigravity", "1.1.13", "unknown", "installed", ["cli"], "trusted", false, false],
    ["copilot", "1.12.0", "unknown", "installed", ["cli", "acp"], "trusted", true, false],
    ["goose", "1.21.0", "unknown", "installed", ["cli", "acp"], "trusted", true, false],
  ]);
});

await test("does not call empty or unhealthy CLI auth state ready", async () => {
  const discover = (adapters as unknown as Record<string, unknown>).discoverLocalCliAgents;
  ok(typeof discover === "function");
  const host: DiscoveryHost = {
    async locate(executable) {
      if (executable === "opencode" || executable === "openclaw") return `/usr/bin/${executable}`;
      return undefined;
    },
    async run(executable, args) {
      const name = executable.split(/[\\/]/).at(-1) ?? executable;
      if (args.includes("--version")) return { exitCode: 0, stdout: `${name} 1.2.3`, stderr: "" };
      if (name === "opencode") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: JSON.stringify({ ok: false, gateway: { status: "offline" } }), stderr: "" };
    },
  };
  const discovered = await (discover as DiscoverFn)({ host });
  equal(discovered.map((a) => [a.type, a.authStatus, a.status]), [
    ["opencode", "unauthenticated", "installed"],
    ["openclaw", "unauthenticated", "installed"],
  ]);
});

await test("registers routable CLI agents with trust and transport evidence", async () => {
  const register = (adapters as unknown as Record<string, unknown>).discoverAndRegisterLocalCliAgents;
  ok(typeof register === "function", "discoverAndRegisterLocalCliAgents must be exported");
  const events = new EventStore("node-local", createMonotonicIdFactory("discovery"));
  const registry = new AgentRegistry(events);
  const registered = await (register as RegisterFn)({ registry, nodeId: "node-local", host: configuredHost() });

  equal(registered.map((agent) => [agent.id, agent.adapterType, agent.status, agent.canonicalUri]), [
    ["claude-local", "claude-code", "idle", "a2a://node-local/agents/claude-local"],
    ["codex-local", "codex", "idle", "a2a://node-local/agents/codex-local"],
    ["hermes-local", "hermes", "idle", "a2a://node-local/agents/hermes-local"],
    ["opencode-local", "opencode", "idle", "a2a://node-local/agents/opencode-local"],
    ["openclaw-local", "openclaw", "idle", "a2a://node-local/agents/openclaw-local"],
  ]);
  equal(registry.get("claude-local").metadata, {
    source: "local-cli-discovery",
    executablePath: "/usr/bin/claude",
    version: "2.1.0",
    authStatus: "authenticated",
    transportTypes: ["cli", "mcp"],
    trustStatus: "trusted",
    supportsAcp: false,
    supportsStreaming: false,
    supportsSessions: true,
    supportsCancellation: true,
    supportsTools: true,
    supportsMcp: true,
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} discovery tests failed`);
