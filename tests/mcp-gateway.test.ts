import * as orchestration from "../packages/orchestration/src/index.js";
import { AgentRegistry, EventStore, createMonotonicIdFactory } from "../packages/core/src/index.js";
import { DeterministicAdapter } from "../packages/adapters/src/index.js";
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

type CollectiveGateway = {
  listAgents(input?: { capability?: string }): Array<Record<string, unknown>>;
  findAgent(input: { query?: string; capability?: string }): Array<Record<string, unknown>>;
  askAgent(input: { agentId: string; prompt: string; conversationId?: string; taskId?: string; workspaceId?: string }): Promise<Record<string, unknown>>;
};
type CreateGateway = (options: { registry: AgentRegistry; id?: (prefix: string) => string }) => CollectiveGateway;
type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
type ToolRegistrar = { registerTool(name: string, config: Record<string, unknown>, handler: ToolHandler): unknown };

function makeRegistry(): AgentRegistry {
  const events = new EventStore("node-local", createMonotonicIdFactory("mcp-test"));
  const registry = new AgentRegistry(events);
  registry.registerAdapter(new DeterministicAdapter({
    "codex-local": (_agent, request) => ({
      content: [{ type: "text", text: `codex:${request.content.map((part) => part.type === "text" ? part.text : "").join("")}` }],
      artifacts: [],
      vendorMessageId: "codex-msg-1",
    }),
    "claude-local": (_agent, request) => ({
      content: [{ type: "text", text: `claude:${request.content.map((part) => part.type === "text" ? part.text : "").join("")}` }],
      artifacts: [],
    }),
  }));
  const agents: RegisteredAgent[] = [
    {
      id: "codex-local", nodeId: "node-local", canonicalUri: "a2a://node-local/agents/codex-local",
      name: "Codex Local", adapterType: "deterministic", capabilities: ["ask", "review", "debug"],
      status: "idle", ephemeral: false, metadata: { source: "test", version: "0.149.0", secretToken: "do-not-expose" },
    },
    {
      id: "claude-local", nodeId: "node-local", canonicalUri: "a2a://node-local/agents/claude-local",
      name: "Claude Code Local", adapterType: "deterministic", capabilities: ["ask", "research", "review"],
      status: "degraded", ephemeral: false, metadata: { source: "test", version: "2.1.0", internalNote: "private" },
    },
  ];
  for (const agent of agents) registry.register(agent);
  return registry;
}

function makeGateway(): CollectiveGateway {
  const create = (orchestration as unknown as Record<string, unknown>).createCollectiveToolGateway;
  ok(typeof create === "function", "createCollectiveToolGateway must be exported");
  let n = 0;
  return (create as CreateGateway)({ registry: makeRegistry(), id: (prefix) => `${prefix}-${++n}` });
}

await test("collective gateway lists and finds registered agents without exposing arbitrary metadata", () => {
  const gateway = makeGateway();
  equal(gateway.listAgents({ capability: "review" }), [
    {
      id: "codex-local", name: "Codex Local", canonicalUri: "a2a://node-local/agents/codex-local",
      adapterType: "deterministic", status: "idle", capabilities: ["ask", "review", "debug"], metadata: { source: "test", version: "0.149.0" },
    },
    {
      id: "claude-local", name: "Claude Code Local", canonicalUri: "a2a://node-local/agents/claude-local",
      adapterType: "deterministic", status: "degraded", capabilities: ["ask", "research", "review"], metadata: { source: "test", version: "2.1.0" },
    },
  ]);
  equal(gateway.findAgent({ query: "codex", capability: "debug" }).map((agent) => agent.id), ["codex-local"]);
  equal(gateway.findAgent({ query: "claude", capability: "debug" }), []);
});

await test("collective gateway asks a selected agent through its registered adapter", async () => {
  const gateway = makeGateway();
  equal(await gateway.askAgent({ agentId: "codex-local", prompt: "inspect this", conversationId: "conv-explicit" }), {
    agentId: "codex-local",
    conversationId: "conv-explicit",
    content: [{ type: "text", text: "codex:inspect this" }],
    artifacts: [],
    vendorMessageId: "codex-msg-1",
  });

  const generated = await gateway.askAgent({ agentId: "claude-local", prompt: "research that" });
  equal(generated.agentId, "claude-local");
  equal(generated.conversationId, "conversation-1");
  equal(generated.content, [{ type: "text", text: "claude:research that" }]);
});

await test("MCP layer registers list, find, and ask tools backed by the collective gateway", async () => {
  const modulePath = "../packages/mcp/src/index.js";
  const mcp = await import(modulePath) as Record<string, unknown>;
  const register = mcp.registerCollectiveMcpTools;
  ok(typeof register === "function", "registerCollectiveMcpTools must be exported");

  const tools = new Map<string, { config: Record<string, unknown>; handler: ToolHandler }>();
  const server: ToolRegistrar = {
    registerTool(name, config, handler) { tools.set(name, { config, handler }); return {}; },
  };
  (register as (server: ToolRegistrar, gateway: CollectiveGateway) => void)(server, makeGateway());
  equal([...tools.keys()], ["list_agents", "find_agent", "ask_agent"]);

  const listed = await tools.get("list_agents")!.handler({ capability: "debug" });
  equal(listed.structuredContent, { agents: [{
    id: "codex-local", name: "Codex Local", canonicalUri: "a2a://node-local/agents/codex-local",
    adapterType: "deterministic", status: "idle", capabilities: ["ask", "review", "debug"], metadata: { source: "test", version: "0.149.0" },
  }] });

  const found = await tools.get("find_agent")!.handler({ query: "claude", capability: "review" });
  equal((found.structuredContent as { agents: Array<{ id: string }> }).agents.map((agent) => agent.id), ["claude-local"]);

  const asked = await tools.get("ask_agent")!.handler({ agentId: "codex-local", prompt: "review it", conversationId: "conv-mcp" });
  equal(asked.structuredContent, {
    agentId: "codex-local", conversationId: "conv-mcp",
    content: [{ type: "text", text: "codex:review it" }], artifacts: [], vendorMessageId: "codex-msg-1",
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} MCP gateway tests failed`);
