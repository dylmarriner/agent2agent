import { A2A_PROTOCOL_VERSION, Role, type AgentCard, type Message, type SendMessageRequest } from "@a2a-js/sdk";
import type { A2aClientDriver, A2aClientRequestOptions } from "../packages/a2a/src/index.js";
import { createControlPlaneRuntime } from "../apps/api/src/runtime.js";
import { toPublicAgent } from "../apps/api/src/server.js";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function card(): AgentCard {
  return {
    name: "Remote Reviewer",
    description: "Remote A2A reviewer",
    supportedInterfaces: [{
      url: "https://peer.example/a2a",
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: A2A_PROTOCOL_VERSION,
    }],
    provider: { organization: "Peer Lab", url: "https://peer.example" },
    version: "1.0.0",
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [{
      id: "security-review",
      name: "Security review",
      description: "Review security-sensitive changes",
      tags: ["review", "security"],
      examples: [],
      inputModes: ["text"],
      outputModes: ["text"],
      securityRequirements: [],
    }],
    documentationUrl: "",
    signatures: [],
  };
}

await test("runtime discovers configured A2A Agent Cards and supports trust transitions", async () => {
  const resolvedUrls: string[] = [];
  let captured: SendMessageRequest | undefined;
  let capturedOptions: A2aClientRequestOptions | undefined;
  const driver: A2aClientDriver = {
    async resolveAgentCard(cardUrl) {
      resolvedUrls.push(cardUrl);
      return card();
    },
    async sendMessage(_card, request, options) {
      captured = request;
      capturedOptions = options;
      return {
        role: Role.ROLE_AGENT,
        messageId: "reply-1",
        contextId: request.message?.contextId ?? "",
        taskId: "remote-task-1",
        parts: [{ content: { $case: "text", value: "review complete" }, mediaType: "text/plain", filename: "", metadata: {} }],
        metadata: {}, extensions: [], referenceTaskIds: [],
      } as Message;
    },
    async cancelTask() {},
  };

  const runtime = await createControlPlaneRuntime({
    nodeId: "runtime-a2a-test",
    autoInstall: false,
    enableAcp: false,
    a2aClientDriver: driver,
    env: {
      A2A_REVIEWER_TOKEN: "peer-secret-token",
      AGENT2AGENT_A2A_PEERS_JSON: JSON.stringify([{
        id: "remote-reviewer",
        cardUrl: "https://peer.example/.well-known/agent-card.json",
        trustStatus: "pending-trust",
        bearerTokenEnv: "A2A_REVIEWER_TOKEN",
      }]),
    },
  });

  equal(resolvedUrls, ["https://peer.example/.well-known/agent-card.json"]);
  const pending = runtime.registry.get("remote-reviewer");
  equal(pending.adapterType, "a2a");
  equal(pending.status, "degraded");
  equal(toPublicAgent(pending).supportsA2a, true);
  equal(JSON.stringify(pending.metadata).includes("peer-secret-token"), false);

  const trusted = await runtime.trustAgent("remote-reviewer", "trusted");
  equal(trusted.status, "idle");
  equal(trusted.metadata.trustStatus, "trusted");

  const adapter = runtime.registry.adapterFor("remote-reviewer");
  const session = await adapter.createSession(trusted, { conversationId: "conversation-remote", taskId: "local-task" });
  const result = await adapter.send(
    session,
    { intent: "review", content: [{ type: "text", text: "review this" }], artifacts: [] },
    { conversationId: "conversation-remote", taskId: "local-task" },
  );
  equal(result.content, [{ type: "text", text: "review complete" }]);
  equal(captured?.message?.contextId, "conversation-remote");
  equal(captured?.message?.taskId, "");
  equal(captured?.message?.metadata?.["agent2agent.localTaskId"], "local-task");
  equal(capturedOptions?.bearerToken, "peer-secret-token");

  const disabled = await runtime.trustAgent("remote-reviewer", "disabled");
  equal(disabled.status, "disabled");
  equal(disabled.metadata.trustStatus, "disabled");
  await runtime.close();
});

await test("runtime rejects malformed or unresolved A2A peer secrets before network discovery", async () => {
  let malformedMessage = "";
  try {
    await createControlPlaneRuntime({
      nodeId: "runtime-a2a-invalid",
      autoInstall: false,
      enableAcp: false,
      a2aClientDriver: {
        async resolveAgentCard() { throw new Error("network discovery should not run"); },
        async sendMessage() { throw new Error("unused"); },
        async cancelTask() {},
      },
      env: { AGENT2AGENT_A2A_PEERS_JSON: '[{"id":"peer"}]' },
    });
  } catch (error) {
    malformedMessage = error instanceof Error ? error.message : String(error);
  }
  equal(/cardUrl/i.test(malformedMessage), true);

  let secretMessage = "";
  try {
    await createControlPlaneRuntime({
      nodeId: "runtime-a2a-missing-secret",
      autoInstall: false,
      enableAcp: false,
      a2aClientDriver: {
        async resolveAgentCard() { throw new Error("network discovery should not run"); },
        async sendMessage() { throw new Error("unused"); },
        async cancelTask() {},
      },
      env: {
        AGENT2AGENT_A2A_PEERS_JSON: JSON.stringify([{
          id: "peer",
          cardUrl: "https://peer.example/.well-known/agent-card.json",
          bearerTokenEnv: "MISSING_A2A_TOKEN",
        }]),
      },
    });
  } catch (error) {
    secretMessage = error instanceof Error ? error.message : String(error);
  }
  equal(/MISSING_A2A_TOKEN|bearerTokenEnv/i.test(secretMessage), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} A2A runtime tests failed`);
