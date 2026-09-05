import { randomUUID } from "node:crypto";
import {
  A2A_PROTOCOL_VERSION,
  Role,
  TaskState,
  type AgentCard,
  type Artifact,
  type Message,
  type Part,
  type SendMessageRequest,
  type SendMessageResult,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import type { EventStore } from "../../core/src/index.js";
import type { ConversationDispatcher } from "../../conversation/src/dispatcher.js";
import type { ConversationRuntime } from "../../conversation/src/index.js";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentContext,
  AgentHealth,
  AgentRequest,
  AgentResponse,
  AgentSession,
  AgentSessionOptions,
  CollaborationIntent,
  MessagePart,
  RegisteredAgent,
} from "../../protocol/src/index.js";

export interface A2aRegistry {
  list(): RegisteredAgent[];
  get(id: string): RegisteredAgent;
  register(agent: RegisteredAgent): RegisteredAgent;
  registerAdapter(adapter: AgentAdapter): void;
}

export interface CreateCollectiveAgentCardOptions {
  nodeId: string;
  baseUrl: string;
  registry: Pick<A2aRegistry, "list">;
  name?: string;
  description?: string;
}

/** Builds an A2A v1 Agent Card from the collective's currently exposed local capabilities. */
export function createCollectiveAgentCard(options: CreateCollectiveAgentCardOptions): AgentCard {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const localAgents = options.registry.list()
    .filter((agent) => agent.adapterType !== "a2a" && agent.status !== "disabled")
    .filter((agent) => trustStatus(agent) === "trusted");

  const agentSkills = localAgents.map((agent) => ({
    id: `agent:${agent.id}`,
    name: agent.name,
    description: `Delegate work to ${agent.name} through the Agent2Agent collective.`,
    tags: unique(agent.capabilities),
    examples: [],
    inputModes: ["text"],
    outputModes: ["text"],
    securityRequirements: [],
  }));

  return {
    name: options.name ?? `Agent2Agent Collective (${options.nodeId})`,
    description: options.description ?? "Federated collective of locally registered AI agents.",
    supportedInterfaces: [{
      url: `${baseUrl}/a2a`,
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: A2A_PROTOCOL_VERSION,
    }],
    provider: { organization: "Agent2Agent", url: baseUrl },
    version: "0.1.0",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "collective-delegation",
        name: "Collective delegation",
        description: "Route work to one or more trusted agents in this Agent2Agent node.",
        tags: unique(localAgents.flatMap((agent) => agent.capabilities)),
        examples: [],
        inputModes: ["text"],
        outputModes: ["text"],
        securityRequirements: [],
      },
      ...agentSkills,
    ],
    documentationUrl: "",
    signatures: [],
  };
}

export interface CollectiveA2aExecutorOptions {
  nodeId: string;
  registry: Pick<A2aRegistry, "list" | "get">;
  conversations: ConversationRuntime;
  dispatcher: ConversationDispatcher;
  events: EventStore;
}

/** Bridges inbound A2A tasks into the canonical conversation runtime and streams normalized results back as A2A events. */
export class CollectiveA2aExecutor implements AgentExecutor {
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly options: CollectiveA2aExecutorOptions) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;
    assertExternalId(taskId, "A2A task id");
    assertExternalId(contextId, "A2A context id");
    const controller = new AbortController();
    this.active.set(taskId, controller);

    try {
      const text = a2aMessageText(userMessage);
      if (!text) throw new Error("Inbound A2A message must contain a non-empty text part");
      const metadata = recordValue(userMessage.metadata);
      const peerId = externalPeerId(metadata["agent2agent.peerId"]);
      const senderId = `a2a:${peerId}`;
      const intent = collaborationIntent(metadata["agent2agent.intent"]);
      const routable = this.routableLocalAgents();
      const requestedTargets = stringArray(metadata["agent2agent.targetAgentIds"]);
      const targetIds = requestedTargets.length > 0
        ? requestedTargets.map((id) => this.requireRoutableTarget(id, routable).id)
        : routable.map((agent) => agent.id);
      if (targetIds.length === 0) throw new Error("No trusted local agents are available for inbound A2A work");

      const conversationId = `a2a:${contextId}`;
      await this.ensureConversation(conversationId, senderId, routable, text);

      const initialTask: Task = {
        id: taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          timestamp: new Date().toISOString(),
          message: undefined,
        },
        artifacts: [],
        history: [structuredClone(userMessage)],
        metadata: userMessage.metadata,
      };
      eventBus.publish(AgentEvent.task(initialTask));
      eventBus.publish(AgentEvent.statusUpdate(statusUpdate(taskId, contextId, TaskState.TASK_STATE_WORKING)));

      this.options.events.publish("federation.task_received", {
        peerId,
        remoteTaskId: taskId,
        remoteContextId: contextId,
        targetAgentIds: [...targetIds],
      }, { conversationId, taskId });

      const canonical = await this.options.conversations.sendAgentMessage(conversationId, {
        senderAgentId: senderId,
        recipientAgentIds: targetIds,
        text,
        intent,
        taskId,
      });
      const produced = await this.options.dispatcher.dispatch(canonical, { signal: controller.signal });
      const resultText = produced
        .map((message) => message.content.map(messagePartText).filter(Boolean).join("\n"))
        .filter(Boolean)
        .join("\n\n")
        .trim() || "Agent2Agent collective completed without a textual result.";

      const artifact: Artifact = {
        artifactId: randomUUID(),
        name: "Agent2Agent result",
        description: "Result produced by the Agent2Agent collective.",
        parts: [a2aTextPart(resultText)],
        metadata: {
          "agent2agent.nodeId": this.options.nodeId,
          "agent2agent.conversationId": conversationId,
          "agent2agent.agentIds": unique(produced.map((message) => message.senderAgentId)),
        },
        extensions: [],
      };
      const artifactUpdate: TaskArtifactUpdateEvent = {
        taskId,
        contextId,
        artifact,
        lastChunk: true,
        append: false,
        metadata: undefined,
      };
      eventBus.publish(AgentEvent.artifactUpdate(artifactUpdate));
      eventBus.publish(AgentEvent.statusUpdate(statusUpdate(taskId, contextId, TaskState.TASK_STATE_COMPLETED)));
    } catch (error) {
      if (controller.signal.aborted) {
        eventBus.publish(AgentEvent.statusUpdate(statusUpdate(taskId, contextId, TaskState.TASK_STATE_CANCELED)));
        return;
      }
      this.options.events.publish("federation.failed", {
        direction: "inbound",
        remoteTaskId: taskId,
        remoteContextId: contextId,
        message: error instanceof Error ? error.message : String(error),
      }, { conversationId: `a2a:${contextId}`, taskId });
      eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
        taskId,
        contextId,
        TaskState.TASK_STATE_FAILED,
        error instanceof Error ? error.message : String(error),
      )));
    } finally {
      this.active.delete(taskId);
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const controller = this.active.get(taskId);
    controller?.abort(new Error(`A2A task ${taskId} cancelled`));
    eventBus.publish(AgentEvent.statusUpdate({
      taskId,
      contextId: "",
      status: {
        state: TaskState.TASK_STATE_CANCELED,
        timestamp: new Date().toISOString(),
        message: undefined,
      },
      metadata: {},
    }));
  }

  private routableLocalAgents(): RegisteredAgent[] {
    return this.options.registry.list()
      .filter((agent) => agent.adapterType !== "a2a")
      .filter((agent) => agent.status === "idle" || agent.status === "busy")
      .filter((agent) => trustStatus(agent) === "trusted");
  }

  private requireRoutableTarget(id: string, allowed: RegisteredAgent[]): RegisteredAgent {
    const target = allowed.find((agent) => agent.id === id);
    if (!target) throw new Error(`A2A target ${id} is not a trusted local routable agent`);
    return target;
  }

  private async ensureConversation(
    conversationId: string,
    senderId: string,
    routableAgents: RegisteredAgent[],
    objective: string,
  ): Promise<void> {
    const existing = (await this.options.conversations.list()).find((conversation) => conversation.id === conversationId);
    if (existing) {
      if (!existing.participantIds.includes(senderId)) throw new Error(`A2A context ${conversationId} belongs to a different remote peer`);
      return;
    }
    await this.options.conversations.create({
      id: conversationId,
      title: `A2A federation ${conversationId.slice(4)}`,
      objective: objective.slice(0, 500),
      participantIds: [senderId, ...routableAgents.map((agent) => agent.id)],
    });
  }
}

export interface A2aClientDriver {
  resolveAgentCard(cardUrl: string, signal?: AbortSignal): Promise<AgentCard>;
  sendMessage(card: AgentCard, request: SendMessageRequest, signal?: AbortSignal): Promise<SendMessageResult>;
  cancelTask(card: AgentCard, taskId: string, signal?: AbortSignal): Promise<void>;
}

/** Official-SDK backed client driver. Kept behind an interface so federation tests do not require a network. */
export class OfficialA2aClientDriver implements A2aClientDriver {
  private readonly factory = new ClientFactory();

  async resolveAgentCard(cardUrl: string, signal?: AbortSignal): Promise<AgentCard> {
    const url = validateRemoteUrl(cardUrl);
    if (signal?.aborted) throw signal.reason ?? new Error("A2A Agent Card request aborted");
    const client = await this.factory.createFromUrl(url.toString(), "");
    return client.getAgentCard(signal ? { signal } : undefined);
  }

  async sendMessage(card: AgentCard, request: SendMessageRequest, signal?: AbortSignal): Promise<SendMessageResult> {
    const client = await this.factory.createFromAgentCard(card);
    return client.sendMessage(request, signal ? { signal } : undefined);
  }

  async cancelTask(card: AgentCard, taskId: string, signal?: AbortSignal): Promise<void> {
    const client = await this.factory.createFromAgentCard(card);
    await client.cancelTask({ id: taskId, tenant: "", metadata: {} }, signal ? { signal } : undefined);
  }
}

interface RemotePeerState {
  cardUrl: string;
  card: AgentCard;
  trustStatus: "trusted" | "pending-trust" | "disabled";
}

interface RemoteSessionState {
  agentId: string;
  options: AgentSessionOptions;
  taskId?: string;
}

export interface A2aRemoteAdapterOptions {
  nodeId: string;
  events: EventStore;
  driver?: A2aClientDriver;
}

/** Makes a remote A2A Agent Card look like a normal AgentAdapter to the collective runtime. */
export class A2aRemoteAdapter implements AgentAdapter {
  readonly type = "a2a";
  private readonly peers = new Map<string, RemotePeerState>();
  private readonly sessions = new Map<string, RemoteSessionState>();
  private readonly driver: A2aClientDriver;
  private sessionCounter = 0;

  constructor(private readonly options: A2aRemoteAdapterOptions) {
    this.driver = options.driver ?? new OfficialA2aClientDriver();
  }

  async discover(): Promise<AgentCapabilities> {
    return {
      capabilities: ["ask", "delegate", "research", "review", "verify", "test", "synthesize"],
      supportsStreaming: true,
      supportsSessions: true,
      supportsCancellation: true,
      supportsTools: false,
    };
  }

  async healthCheck(agent: RegisteredAgent): Promise<AgentHealth> {
    const peer = this.requirePeer(agent.id);
    if (peer.trustStatus !== "trusted") {
      return { ok: false, message: `A2A peer is ${peer.trustStatus}`, checkedAt: new Date().toISOString() };
    }
    try {
      await this.driver.resolveAgentCard(peer.cardUrl);
      return { ok: true, message: "A2A Agent Card reachable", checkedAt: new Date().toISOString() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
    }
  }

  async createSession(agent: RegisteredAgent, options: AgentSessionOptions): Promise<AgentSession> {
    const peer = this.requirePeer(agent.id);
    if (peer.trustStatus !== "trusted") throw new Error(`A2A peer ${agent.id} is ${peer.trustStatus}`);
    const session: AgentSession = {
      id: `a2a-${++this.sessionCounter}`,
      agentId: agent.id,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, { agentId: agent.id, options });
    return session;
  }

  async send(session: AgentSession, request: AgentRequest, context: AgentContext): Promise<AgentResponse> {
    const state = this.sessions.get(session.id);
    if (!state) throw new Error(`Unknown A2A session ${session.id}`);
    const peer = this.requirePeer(state.agentId);
    if (peer.trustStatus !== "trusted") throw new Error(`A2A peer ${state.agentId} is ${peer.trustStatus}`);
    const taskId = context.taskId ?? state.options.taskId;
    const outbound: SendMessageRequest = {
      tenant: "",
      message: {
        role: Role.ROLE_USER,
        messageId: randomUUID(),
        contextId: context.conversationId,
        taskId: taskId ?? "",
        parts: request.content.map(internalPartToA2a),
        metadata: {
          "agent2agent.originNodeId": this.options.nodeId,
          "agent2agent.intent": request.intent,
        },
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: { acceptedOutputModes: ["text"], returnImmediately: false },
      metadata: {},
    };

    try {
      const result = await this.driver.sendMessage(peer.card, outbound, context.signal);
      if ("id" in result) state.taskId = result.id;
      else if (result.taskId) state.taskId = result.taskId;
      this.options.events.publish("federation.task_sent", {
        agentId: state.agentId,
        remoteTaskId: state.taskId ?? taskId,
        contextId: context.conversationId,
        protocolVersion: preferredProtocolVersion(peer.card),
      }, { conversationId: context.conversationId, ...(taskId ? { taskId } : {}), agentId: state.agentId });
      return a2aResultToAgentResponse(result);
    } catch (error) {
      this.options.events.publish("federation.failed", {
        direction: "outbound",
        agentId: state.agentId,
        contextId: context.conversationId,
        message: error instanceof Error ? error.message : String(error),
      }, { conversationId: context.conversationId, ...(taskId ? { taskId } : {}), agentId: state.agentId });
      throw error;
    }
  }

  async cancel(executionId: string): Promise<void> {
    const state = this.sessions.get(executionId);
    if (!state?.taskId) return;
    const peer = this.requirePeer(state.agentId);
    await this.driver.cancelTask(peer.card, state.taskId);
  }

  async terminateSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async resolveAndStorePeer(
    agentId: string,
    cardUrl: string,
    trust: RemotePeerState["trustStatus"],
    signal?: AbortSignal,
  ): Promise<AgentCard> {
    validateRemoteUrl(cardUrl);
    const card = await this.driver.resolveAgentCard(cardUrl, signal);
    if (!card.supportedInterfaces.some((entry) => entry.protocolVersion === A2A_PROTOCOL_VERSION)) {
      throw new Error(`A2A peer ${agentId} does not advertise protocol ${A2A_PROTOCOL_VERSION}`);
    }
    this.peers.set(agentId, { cardUrl, card: structuredClone(card), trustStatus: trust });
    return structuredClone(card);
  }

  private requirePeer(agentId: string): RemotePeerState {
    const peer = this.peers.get(agentId);
    if (!peer) throw new Error(`Unknown A2A peer ${agentId}`);
    return peer;
  }
}

export interface RegisterRemoteA2aPeerOptions {
  registry: Pick<A2aRegistry, "register">;
  adapter: A2aRemoteAdapter;
  nodeId: string;
  agentId: string;
  cardUrl: string;
  trustStatus?: "trusted" | "pending-trust" | "disabled";
  signal?: AbortSignal;
}

/** Discovers an A2A Agent Card and registers it as an ordinary collective agent. */
export async function registerRemoteA2aPeer(options: RegisterRemoteA2aPeerOptions): Promise<RegisteredAgent> {
  const agentId = options.agentId.trim();
  if (!agentId || agentId.startsWith("human:")) throw new Error("Remote A2A agent id must be a non-human identifier");
  const trust = options.trustStatus ?? "pending-trust";
  const card = await options.adapter.resolveAndStorePeer(agentId, options.cardUrl, trust, options.signal);
  const capabilities = unique(card.skills.map((skill) => skill.id));
  const protocolVersion = preferredProtocolVersion(card);
  const agent: RegisteredAgent = {
    id: agentId,
    nodeId: options.nodeId,
    canonicalUri: card.supportedInterfaces[0]?.url ?? options.cardUrl,
    name: card.name,
    adapterType: options.adapter.type,
    capabilities,
    status: trust === "trusted" ? "idle" : trust === "disabled" ? "disabled" : "degraded",
    ephemeral: false,
    metadata: {
      source: "a2a-agent-card",
      cardUrl: options.cardUrl,
      protocolVersion,
      transportTypes: ["a2a"],
      trustStatus: trust,
      supportsA2a: true,
      supportsStreaming: card.capabilities?.streaming === true,
      supportsSessions: true,
      supportsCancellation: true,
      supportsTools: false,
    },
  };
  const registered = options.registry.register(agent);
  return registered;
}

function a2aResultToAgentResponse(result: SendMessageResult): AgentResponse {
  if ("messageId" in result) {
    return {
      content: a2aPartsToInternal(result.parts),
      artifacts: [],
      vendorMessageId: result.messageId,
    };
  }

  const content: MessagePart[] = [];
  if (result.status.message) content.push(...a2aPartsToInternal(result.status.message.parts));
  for (const artifact of result.artifacts) content.push(...a2aPartsToInternal(artifact.parts));
  if (content.length === 0) content.push({ type: "json", value: { taskId: result.id, state: result.status.state } });
  return { content, artifacts: [], vendorMessageId: result.id };
}

function a2aPartsToInternal(parts: Part[]): MessagePart[] {
  return parts.map((part): MessagePart => {
    switch (part.content?.$case) {
      case "text": return { type: "text", text: part.content.value };
      case "data": return { type: "json", value: part.content.value };
      case "url": return { type: "reference", uri: part.content.value, ...(part.mediaType ? { mediaType: part.mediaType } : {}) };
      case "raw": return { type: "json", value: { encoding: "base64", data: Buffer.from(part.content.value).toString("base64"), mediaType: part.mediaType } };
      default: return { type: "json", value: { unsupportedA2aPart: true } };
    }
  });
}

function internalPartToA2a(part: MessagePart): Part {
  if (part.type === "text") return a2aTextPart(part.text);
  if (part.type === "reference") {
    return {
      content: { $case: "url", value: part.uri },
      mediaType: part.mediaType ?? "application/octet-stream",
      filename: "",
      metadata: {},
    };
  }
  return {
    content: { $case: "data", value: recordValue(part.value) },
    mediaType: "application/json",
    filename: "",
    metadata: {},
  };
}

function a2aTextPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    mediaType: "text/plain",
    filename: "",
    metadata: {},
  };
}

function a2aMessageText(message: Message): string {
  return message.parts
    .filter((part) => part.content?.$case === "text")
    .map((part) => part.content?.$case === "text" ? part.content.value : "")
    .join("\n")
    .trim();
}

function messagePartText(part: MessagePart): string {
  return part.type === "text" ? part.text : part.type === "json" ? JSON.stringify(part.value) : part.uri;
}

function statusUpdate(taskId: string, contextId: string, state: TaskState, message?: string): TaskStatusUpdateEvent {
  return {
    taskId,
    contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: message ? {
        role: Role.ROLE_AGENT,
        messageId: randomUUID(),
        parts: [a2aTextPart(message)],
        taskId,
        contextId,
        extensions: [],
        metadata: {},
        referenceTaskIds: [],
      } : undefined,
    },
    metadata: {},
  };
}

function collaborationIntent(value: unknown): CollaborationIntent {
  const allowed = new Set<CollaborationIntent>([
    "ask", "delegate", "research", "review", "critique", "verify", "test", "debug", "improve", "compare",
    "challenge", "teach", "summarize", "vote", "synthesize", "spawn-specialist", "merge-findings", "request-memory",
    "publish-knowledge", "request-skill",
  ]);
  return typeof value === "string" && allowed.has(value as CollaborationIntent) ? value as CollaborationIntent : "delegate";
}

function externalPeerId(value: unknown): string {
  const peer = typeof value === "string" ? value.trim() : "remote";
  if (!peer || peer.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(peer)) return "remote";
  return peer;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? unique(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))
    : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function trustStatus(agent: RegisteredAgent): "trusted" | "pending-trust" | "disabled" {
  const value = agent.metadata.trustStatus;
  return value === "pending-trust" || value === "disabled" ? value : "trusted";
}

function preferredProtocolVersion(card: AgentCard): string {
  return card.supportedInterfaces.find((entry) => entry.protocolVersion === A2A_PROTOCOL_VERSION)?.protocolVersion
    ?? card.supportedInterfaces[0]?.protocolVersion
    ?? A2A_PROTOCOL_VERSION;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A2A base URL must use http or https");
  if (url.username || url.password) throw new Error("A2A base URL must not contain credentials");
  return url.toString().replace(/\/$/, "");
}

function validateRemoteUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A2A peer URL must use http or https");
  if (url.username || url.password) throw new Error("A2A peer URL must not contain embedded credentials");
  return url;
}

function assertExternalId(value: string, label: string): void {
  if (!value.trim() || value.length > 512) throw new Error(`${label} must be a non-empty string up to 512 characters`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
