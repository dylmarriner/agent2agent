import { AcpAgentAdapter, discoverAcpEndpoints, registerAcpEndpoints, type AcpConnector } from "../packages/acp/src/index.js";
import { AgentRegistry, EventStore, createMonotonicIdFactory } from "../packages/core/src/index.js";
import { DeterministicAdapter } from "../packages/adapters/src/index.js";

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

type Host = { locate(executable: string): Promise<string | undefined>; run(executable: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> };

const host: Host = {
  async locate(executable) {
    const paths: Record<string, string | undefined> = {
      hermes: "/usr/bin/hermes",
      copilot: "/usr/bin/copilot",
      goose: "/usr/bin/goose",
      "agy-acp": "/usr/bin/agy-acp",
      "custom-acp": "/opt/custom/bin/custom-acp",
    };
    return paths[executable];
  },
  async run(executable, args) {
    if (executable.endsWith("hermes") && args.join(" ") === "acp --check") return { exitCode: 0, stdout: "ACP ready", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};

await test("discovers known ACP endpoints and keeps custom endpoints pending trust", async () => {
  const endpoints = await discoverAcpEndpoints({
    host,
    customEndpoints: [{ id: "custom-linter", type: "custom", command: "custom-acp", args: ["serve"] }],
  });
  equal(endpoints.map((endpoint) => [endpoint.id, endpoint.type, endpoint.command, endpoint.args, endpoint.trustStatus, endpoint.source]), [
    ["hermes-acp", "hermes", "/usr/bin/hermes", ["acp"], "trusted", "known"],
    ["copilot-acp", "copilot", "/usr/bin/copilot", ["--acp"], "trusted", "known"],
    ["goose-acp", "goose", "/usr/bin/goose", ["acp"], "trusted", "known"],
    ["antigravity-acp", "antigravity", "/usr/bin/agy-acp", [], "trusted", "known"],
    ["custom-linter", "custom", "/opt/custom/bin/custom-acp", ["serve"], "pending-trust", "custom"],
  ]);
});

await test("ACP registration upgrades an existing canonical agent instead of duplicating it", async () => {
  const events = new EventStore("node-local", createMonotonicIdFactory("acp-discovery"));
  const registry = new AgentRegistry(events);
  const cli = new DeterministicAdapter({});
  registry.registerAdapter(cli);
  registry.register({
    id: "hermes-local",
    nodeId: "node-local",
    canonicalUri: "a2a://node-local/agents/hermes-local",
    name: "Hermes Local",
    adapterType: "deterministic",
    capabilities: ["ask"],
    status: "idle",
    ephemeral: false,
    metadata: { transportTypes: ["cli", "mcp"], trustStatus: "trusted" },
  });

  const connector: AcpConnector = async () => ({
    capabilities: { loadSession: true },
    async newSession() { return "s"; },
    async prompt() { return { stopReason: "end_turn", text: "ok" }; },
    async cancel() {},
    async close() {},
  });
  const endpoints = await discoverAcpEndpoints({ host, customEndpoints: [] });
  const registered = await registerAcpEndpoints({ registry, nodeId: "node-local", endpoints, connector });

  const hermes = registry.get("hermes-local");
  equal(hermes.adapterType, "acp:hermes-acp");
  equal(hermes.metadata.transportTypes, ["cli", "mcp", "acp"]);
  equal(registry.list().filter((agent) => agent.id.startsWith("hermes")).map((agent) => agent.id), ["hermes-local"]);
  ok(registry.adapterFor("hermes-local") instanceof AcpAgentAdapter);
  ok(registered.some((agent) => agent.id === "copilot-local" && agent.adapterType === "acp:copilot-acp"));
  ok(registered.some((agent) => agent.id === "goose-local" && agent.adapterType === "acp:goose-acp"));
  ok(registered.some((agent) => agent.id === "antigravity-local" && agent.adapterType === "acp:antigravity-acp"));
});

await test("pending-trust custom ACP endpoint is visible but not executable", async () => {
  const events = new EventStore("node-local", createMonotonicIdFactory("acp-pending"));
  const registry = new AgentRegistry(events);
  const connector: AcpConnector = async () => { throw new Error("must not connect pending endpoint"); };
  const endpoints = await discoverAcpEndpoints({
    host,
    customEndpoints: [{ id: "custom-linter", type: "custom", command: "custom-acp", args: ["serve"] }],
  });
  await registerAcpEndpoints({ registry, nodeId: "node-local", endpoints, connector });
  const custom = registry.get("custom-linter");
  equal(custom.status, "degraded");
  equal(custom.metadata.trustStatus, "pending-trust");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} ACP discovery tests failed`);
