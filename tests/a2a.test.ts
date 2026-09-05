import {
  A2A_PROTOCOL_VERSION,
  Role,
  type AgentCard,
  type Message,
  type SendMessageRequest,
} from "@a2a-js/sdk";
import { DefaultExecutionEventBus, RequestContext, ServerCallContext } from "@a2a-js/sdk/server";
import {
  A2aRemoteAdapter,
  CollectiveA2aExecutor,
  createCollectiveAgentCard,
  registerRemoteA2aPeer,
  type A2aClientDriver,
} from "../packages/a2a/src/index.js";
import { DeterministicAdapter } from "../packages/adapters/src/index.js";
import { AgentRegistry, EventStore, createMonotonicIdFactory } from "../packages/core/src/index.js";
import { ConversationDispatcher } from "../packages/conversation/src/dispatcher.js";
import { ConversationRuntime, InMemoryConversationRepository } from "../packages/conversation/src/index.js";
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

function textPart(text: string) {
  return {
    content: { $case: "text" as const, value: text },
    mediaType: "text/plain",
    filename: "",
    metadata: {},
  };
}

function makeCollective() {
  const nodeId = "node-a2a-test";
  const id = createMonotonicIdFactory("a2a-test");
  const events = new EventStore(nodeId, id);
  const registry = new AgentRegistry(events);
  const local = new DeterministicAdapter({
    "claude-local": async (_agent, request) => ({
      content: [{ type: "text", text: `Claude: ${request.content[0]?.type === "text" ? request.content[0].text : ""}` }],
      artifacts: [],
    }),
  });
  registry.registerAdapter(local);
  registry.register({
    id: "claude-local",
    nodeId,
    canonicalUri: `a2a://${nodeId}/agents/claude-local`,
    name: "Claude Local",
    adapterType: local.type,
    capabilities: ["ask", "review", "research"],
    status: "idle",
    ephemeral: false,
    metadata: { transportTypes: ["cli", "mcp"], trustStatus: "trusted" },
  });
  const conversations = new ConversationRuntime({
    nodeId,
    id,
    events,
    repository: new InMemoryConversationRepository(),
    humanParticipantId: "human:operator",
  });
  const dispatcher = new ConversationDispatcher({ registry, conversations, events });
  return { nodeId, id, events, registry, conversations, dispatcher };
}

await test("collective Agent Card advertises the official protocol and real local capabilities", () => {
  const collective = makeCollective();
  const card = createCollectiveAgentCard({
    nodeId: collective.nodeId,
    baseUrl: "http://127.0.0.1:8787",
    registry: collective.registry,
  });
  equal(card.supportedInterfaces[0]?.protocolVersion, A2A_PROTOCOL_VERSION);
  equal(card.supportedInterfaces[0]?.protocolBinding, "JSONRPC");
  equal(card.supportedInterfaces[0]?.url, "http://127.0.0.1:8787/a2a");
  ok(card.capabilities?.streaming === true);
  ok(card.skills.some((skill) => skill.id === "collective-delegation"));
  ok(card.skills.some((skill) => skill.id === "agent:claude-local" && skill.tags.includes("review")));
  void collective.dispatcher.close();
});

await test("inbound A2A work becomes a durable canonical conversation and runs through local agents", async () => {
  const collective = makeCollective();
  const executor = new CollectiveA2aExecutor({
    nodeId: collective.nodeId,
    registry: collective.registry,
    conversations: collective.conversations,
    dispatcher: collective.dispatcher,
    events: collective.events,
  });
  const contextId = "remote-context-17";
  const taskId = "remote-task-17";
  const request: SendMessageRequest = {
    tenant: "",
    message: {
      role: Role.ROLE_USER,
      messageId: "remote-message-17",
      contextId,
      taskId,
      parts: [textPart("@claude-local inspect this authentication flow")],
      metadata: {
        "agent2agent.peerId": "remote-security-node",
        "agent2agent.intent": "review",
        "agent2agent.targetAgentIds": ["claude-local"],
      },
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: { acceptedOutputModes: ["text"], returnImmediately: false, taskPushNotificationConfig: undefined },
    metadata: {},
  };
  const requestContext = new RequestContext(
    request,
    taskId,
    contextId,
    new ServerCallContext({ requestedVersion: A2A_PROTOCOL_VERSION }),
  );
  const bus = new DefaultExecutionEventBus();
  const emitted: Array<{ kind: string; data: unknown }> = [];
  bus.on("event", (event) => emitted.push(event));

  await executor.execute(requestContext, bus);

  const conversations = await collective.conversations.list();
  equal(conversations.map((conversation) => conversation.id), [`a2a:${contextId}`]);
  const transcript = await collective.conversations.messages(`a2a:${contextId}`);
  equal(transcript.map((message) => message.senderAgentId), ["a2a:remote-security-node", "claude-local"]);
  ok(emitted.some((event) => event.kind === "task"));
  ok(emitted.some((event) => event.kind === "artifactUpdate"));
  ok(emitted.some((event) => event.kind === "statusUpdate"));
  equal(collective.events.list("federation.task_received").length, 1);
  await collective.dispatcher.close();
});

await test("remote A2A peers register as ordinary routable agents and preserve conversation context", async () => {
  const events = new EventStore("node-local", createMonotonicIdFactory("a2a-remote"));
  const registry = new AgentRegistry(events);
  const card: AgentCard = {
    name: "Remote Security Reviewer",
    description: "Independent remote reviewer",
    supportedInterfaces: [{ url: "https://peer.example/a2a", protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: "Remote Lab", url: "https://peer.example" },
    version: "1.0.0",
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [{ id: "security-review", name: "Security review", description: "Review code", tags: ["security", "review"], examples: [], inputModes: ["text"], outputModes: ["text"], securityRequirements: [] }],
    documentationUrl: "",
    signatures: [],
  };
  let captured: SendMessageRequest | undefined;
  const driver: A2aClientDriver = {
    async resolveAgentCard() { return card; },
    async sendMessage(_card, request) {
      captured = request;
      return {
        role: Role.ROLE_AGENT,
        messageId: "remote-reply-1",
        contextId: request.message?.contextId,
        taskId: request.message?.taskId,
        parts: [textPart("Remote review passed")],
        metadata: {},
        extensions: [],
        referenceTaskIds: [],
      } as Message;
    },
    async cancelTask() {},
  };
  const adapter = new A2aRemoteAdapter({ nodeId: "node-local", events, driver });
  registry.registerAdapter(adapter);
  const remote = await registerRemoteA2aPeer({
    registry,
    adapter,
    nodeId: "node-local",
    agentId: "remote-security",
    cardUrl: "https://peer.example/.well-known/agent-card.json",
    trustStatus: "trusted",
  });
  equal(remote.adapterType, "a2a");
  equal(remote.capabilities.includes("security-review"), true);
  equal(remote.metadata.transportTypes, ["a2a"]);

  const session = await adapter.createSession(remote, { conversationId: "conversation-55", taskId: "task-55" });
  const response = await adapter.send(
    session,
    { intent: "review", content: [{ type: "text", text: "Review this patch" }], artifacts: [] },
    { conversationId: "conversation-55", taskId: "task-55" },
  );
  equal(captured?.message?.contextId, "conversation-55");
  equal(captured?.message?.taskId, "task-55");
  equal(response.content, [{ type: "text", text: "Remote review passed" }]);
  equal(events.list("federation.task_sent").length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} A2A tests failed`);
