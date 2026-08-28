import * as orchestration from "../packages/orchestration/src/index.js";
import { AgentRegistry, EventStore, createMonotonicIdFactory } from "../packages/core/src/index.js";
import { DeterministicAdapter } from "../packages/adapters/src/index.js";
import type { AgentAdapter, AgentContext, AgentSession, RegisteredAgent } from "../packages/protocol/src/index.js";

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

type AskInput = {
  agentId: string;
  prompt: string;
  conversationId?: string;
  taskId?: string;
  workspaceId?: string;
  signal?: AbortSignal;
};
type CollectiveGateway = {
  listAgents(input?: { capability?: string }): Array<Record<string, unknown>>;
  findAgent(input: { query?: string; capability?: string }): Array<Record<string, unknown>>;
  askAgent(input: AskInput): Promise<Record<string, unknown>>;
};
type CreateGatewayOptions = {
  registry: AgentRegistry;
  id?: (prefix: string) => string;
  delegationDepth?: number;
  maxDelegationDepth?: number;
};
type CreateGateway = (options: CreateGatewayOptions) => CollectiveGateway;
type ToolContext = { mcpReq: { signal: AbortSignal } };
type ToolHandler = (args: Record<string, unknown>, context?: ToolContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
type ToolRegistrar = { registerTool(name: string, config: Record<string, unknown>, handler: ToolHandler): unknown };

function createGateway(registry: AgentRegistry, options: Omit<CreateGatewayOptions, "registry" | "id"> = {}): CollectiveGateway {
  const create = (orchestration as unknown as Record<string, unknown>).createCollectiveToolGateway;
  ok(typeof create === "function", "createCollectiveToolGateway must be exported");
  let n = 0;
  return (create as CreateGateway)({ registry, id: (prefix) => `${prefix}-${++n}`, ...options });
}

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
      status: "idle", ephemeral: false, metadata: {
        source: "test", version: "0.149.0", secretToken: "do-not-expose", executablePath: "/home/test/.local/bin/codex",
      },
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

function makeGateway(options: Omit<CreateGatewayOptions, "registry" | "id"> = {}): CollectiveGateway {
  return createGateway(makeRegistry(), options);
}

await test("collective gateway lists and finds registered agents without exposing arbitrary or path metadata", () => {
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

await test("collective gateway reuses vendor sessions for conversation follow-ups and forwards cancellation", async () => {
  const events = new EventStore("session-node", createMonotonicIdFactory("session-test"));
  const registry = new AgentRegistry(events);
  let created = 0;
  let terminated = 0;
  const signals: Array<AbortSignal | undefined> = [];
  const adapter: AgentAdapter = {
    type: "session-tracker",
    async discover() {
      return { capabilities: ["ask"], supportsStreaming: false, supportsSessions: true, supportsCancellation: true, supportsTools: false };
    },
    async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
    async createSession(agent) {
      created += 1;
      return { id: `session-${created}`, agentId: agent.id, createdAt: new Date().toISOString() };
    },
    async send(session: AgentSession, _request, context: AgentContext) {
      signals.push(context.signal);
      const prior = session.vendorSessionId;
      if (!session.vendorSessionId) session.vendorSessionId = "vendor-session-1";
      return { content: [{ type: "text", text: prior ? `resume:${prior}` : "new" }], artifacts: [] };
    },
    async terminateSession() { terminated += 1; },
  };
  registry.registerAdapter(adapter);
  registry.register({
    id: "session-agent", nodeId: "session-node", canonicalUri: "a2a://session-node/agents/session-agent",
    name: "Session Agent", adapterType: "session-tracker", capabilities: ["ask"], status: "idle", ephemeral: false, metadata: {},
  });
  const gateway = createGateway(registry);
  const controller = new AbortController();

  const first = await gateway.askAgent({ agentId: "session-agent", prompt: "first", conversationId: "conv-session", signal: controller.signal });
  const second = await gateway.askAgent({ agentId: "session-agent", prompt: "second", conversationId: "conv-session" });

  equal((first.content as Array<{ text: string }>)[0]?.text, "new");
  equal((second.content as Array<{ text: string }>)[0]?.text, "resume:vendor-session-1");
  equal(created, 1);
  equal(terminated, 0);
  ok(signals[0] === controller.signal, "gateway must forward the caller AbortSignal to the adapter context");
});

await test("collective gateway blocks delegation once the nested depth limit is reached", async () => {
  const gateway = makeGateway({ delegationDepth: 2, maxDelegationDepth: 2 });
  let message = "";
  try {
    await gateway.askAgent({ agentId: "codex-local", prompt: "delegate again" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  equal(message, "Agent2Agent delegation depth limit reached: 2");
});

await test("MCP layer registers safe tool metadata and forwards request cancellation", async () => {
  const modulePath = "../packages/mcp/src/index.js";
  const mcp = await import(modulePath) as Record<string, unknown>;
  const register = mcp.registerCollectiveMcpTools;
  ok(typeof register === "function", "registerCollectiveMcpTools must be exported");

  const tools = new Map<string, { config: Record<string, unknown>; handler: ToolHandler }>();
  const server: ToolRegistrar = {
    registerTool(name, config, handler) { tools.set(name, { config, handler }); return {}; },
  };
  const baseGateway = makeGateway();
  let receivedSignal: AbortSignal | undefined;
  const gateway: CollectiveGateway = {
    listAgents: (input) => baseGateway.listAgents(input),
    findAgent: (input) => baseGateway.findAgent(input),
    askAgent: async (input) => {
      receivedSignal = input.signal;
      return baseGateway.askAgent(input);
    },
  };
  (register as (server: ToolRegistrar, gateway: CollectiveGateway) => void)(server, gateway);
  equal([...tools.keys()], ["list_agents", "find_agent", "ask_agent"]);

  const listed = await tools.get("list_agents")!.handler({ capability: "debug" });
  equal(listed.structuredContent, { agents: [{
    id: "codex-local", name: "Codex Local", canonicalUri: "a2a://node-local/agents/codex-local",
    adapterType: "deterministic", status: "idle", capabilities: ["ask", "review", "debug"], metadata: { source: "test", version: "0.149.0" },
  }] });

  const found = await tools.get("find_agent")!.handler({ query: "claude", capability: "review" });
  equal((found.structuredContent as { agents: Array<{ id: string }> }).agents.map((agent) => agent.id), ["claude-local"]);

  const askTool = tools.get("ask_agent")!;
  const annotations = askTool.config.annotations as Record<string, unknown>;
  equal(annotations.destructiveHint, true);

  const controller = new AbortController();
  const asked = await askTool.handler(
    { agentId: "codex-local", prompt: "review it", conversationId: "conv-mcp" },
    { mcpReq: { signal: controller.signal } },
  );
  ok(receivedSignal === controller.signal, "MCP request cancellation signal must reach the collective gateway");
  equal(asked.structuredContent, {
    agentId: "codex-local", conversationId: "conv-mcp",
    content: [{ type: "text", text: "codex:review it" }], artifacts: [], vendorMessageId: "codex-msg-1",
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} MCP gateway tests failed`);
