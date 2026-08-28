import {
  AcpAgentAdapter,
  type AcpConnector,
  type AcpEndpointConfig,
} from "../packages/acp/src/index.js";
import type { AgentContext, AgentRequest, RegisteredAgent } from "../packages/protocol/src/index.js";

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

const endpoint: AcpEndpointConfig = {
  id: "copilot-acp",
  type: "copilot",
  command: "copilot",
  args: ["--acp"],
  trustStatus: "trusted",
};

await test("creates an ACP session and aggregates streamed agent text", async () => {
  const calls: string[] = [];
  const connector: AcpConnector = async (_config, handlers) => ({
    capabilities: { loadSession: true },
    async newSession(cwd) { calls.push(`new:${cwd}`); return "acp-session-1"; },
    async loadSession(sessionId, cwd) { calls.push(`load:${sessionId}:${cwd}`); },
    async prompt(sessionId, text, signal) {
      calls.push(`prompt:${sessionId}:${text}`);
      handlers.onUpdate({ type: "delta", data: { text: "hello " }, at: new Date().toISOString() });
      handlers.onUpdate({ type: "delta", data: { text: "world" }, at: new Date().toISOString() });
      ok(!signal?.aborted);
      return { stopReason: "end_turn", text: "hello world" };
    },
    async cancel(sessionId) { calls.push(`cancel:${sessionId}`); },
    async close() { calls.push("close"); },
  });

  const adapter = new AcpAgentAdapter(endpoint, connector);
  const agent: RegisteredAgent = {
    id: "copilot-local",
    nodeId: "node-local",
    canonicalUri: "a2a://node-local/agents/copilot-local",
    name: "Copilot",
    adapterType: "acp",
    capabilities: [],
    status: "idle",
    ephemeral: false,
    metadata: {},
  };
  const session = await adapter.createSession(agent, { conversationId: "conv-1", metadata: { cwd: "/repo" } });
  equal(session.vendorSessionId, "acp-session-1");

  const request: AgentRequest = { intent: "ask", content: [{ type: "text", text: "hello" }] };
  const context: AgentContext = { conversationId: "conv-1" };
  const response = await adapter.send(session, request, context);
  equal(response.content, [{ type: "text", text: "hello world" }]);
  equal(calls, ["new:/repo", "prompt:acp-session-1:hello"]);

  await adapter.terminateSession?.(session.id);
  equal(calls.at(-1), "close");
});

await test("cancels ACP prompt when the caller aborts", async () => {
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const connector: AcpConnector = async () => ({
    capabilities: { loadSession: false },
    async newSession() { return "acp-session-2"; },
    async prompt(sessionId, _text, signal) {
      await new Promise<void>((resolve) => {
        release = resolve;
        signal?.addEventListener("abort", resolve, { once: true });
      });
      return { stopReason: "cancelled", text: "" };
    },
    async cancel(sessionId) { calls.push(`cancel:${sessionId}`); release?.(); },
    async close() {},
  });
  const adapter = new AcpAgentAdapter(endpoint, connector);
  const agent = { id: "copilot-local", nodeId: "node-local", canonicalUri: "a2a://node-local/agents/copilot-local", name: "Copilot", adapterType: "acp", capabilities: [], status: "idle", ephemeral: false, metadata: {} } satisfies RegisteredAgent;
  const session = await adapter.createSession(agent, { conversationId: "conv-2" });
  const controller = new AbortController();
  const promise = adapter.send(session, { intent: "ask", content: [{ type: "text", text: "work" }] }, { conversationId: "conv-2", signal: controller.signal });
  controller.abort();
  await promise;
  equal(calls, ["cancel:acp-session-2"]);
});

await test("default ACP permission policy cancels instead of auto-approving", async () => {
  const permission = (await import("../packages/acp/src/index.js")).denyAcpPermission;
  const result = await permission({ sessionId: "s", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } as never);
  equal(result, { outcome: { outcome: "cancelled" } });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} ACP tests failed`);
