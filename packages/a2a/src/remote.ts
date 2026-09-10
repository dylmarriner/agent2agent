import { randomUUID } from "node:crypto";
import {
  A2A_PROTOCOL_VERSION,
  Role,
  type AgentCard,
  type Part,
  type SendMessageRequest,
  type SendMessageResult,
  type StreamResponse,
} from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import type { EventStore } from "../../core/src/index.js";
import type {
  AgentAdapter, AgentCapabilities, AgentContext, AgentHealth, AgentRequest, AgentResponse,
  AgentSession, AgentSessionOptions, MessagePart, RegisteredAgent,
} from "../../protocol/src/index.js";
import {
  a2aTextPart,
  assertSameA2aOrigin,
  preferredProtocolVersion,
  recordValue,
  unique,
  validateRemoteUrl,
  type A2aRegistry,
} from "./common.js";

export interface A2aClientDriver {
  resolveAgentCard(cardUrl: string, signal?: AbortSignal): Promise<AgentCard>;
  sendMessage(card: AgentCard, request: SendMessageRequest, signal?: AbortSignal): Promise<SendMessageResult>;
  sendMessageStream?(card: AgentCard, request: SendMessageRequest, signal?: AbortSignal): AsyncIterable<StreamResponse>;
  cancelTask(card: AgentCard, taskId: string, signal?: AbortSignal): Promise<void>;
}

/** Uses the official A2A JS SDK for discovery, messaging, streaming, and cancellation. */
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
  async *sendMessageStream(card: AgentCard, request: SendMessageRequest, signal?: AbortSignal): AsyncGenerator<StreamResponse, void, undefined> {
    const client = await this.factory.createFromAgentCard(card);
    for await (const event of client.sendMessageStream(request, signal ? { signal } : undefined)) yield event;
  }
  async cancelTask(card: AgentCard, taskId: string, signal?: AbortSignal): Promise<void> {
    const client = await this.factory.createFromAgentCard(card);
    await client.cancelTask({ id: taskId, tenant: "", metadata: {} }, signal ? { signal } : undefined);
  }
}

type PeerTrust = "trusted" | "pending-trust" | "disabled";
interface PeerState { cardUrl: string; card: AgentCard; trustStatus: PeerTrust; }
interface SessionState { agentId: string; options: AgentSessionOptions; taskId: string | undefined; }

export interface A2aRemoteAdapterOptions { nodeId: string; events: EventStore; driver?: A2aClientDriver; }

/** Makes remote A2A peers routable through the same AgentAdapter contract as local agents. */
export class A2aRemoteAdapter implements AgentAdapter {
  readonly type = "a2a";
  private readonly peers = new Map<string, PeerState>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly driver: A2aClientDriver;
  private sessionCounter = 0;

  constructor(private readonly options: A2aRemoteAdapterOptions) { this.driver = options.driver ?? new OfficialA2aClientDriver(); }
  async discover(): Promise<AgentCapabilities> {
    return { capabilities: ["ask", "delegate", "research", "review", "verify", "test", "synthesize"], supportsStreaming: true, supportsSessions: true, supportsCancellation: true, supportsTools: false };
  }
  async healthCheck(agent: RegisteredAgent): Promise<AgentHealth> {
    const peer = this.peer(agent.id);
    if (peer.trustStatus !== "trusted") return { ok: false, message: `A2A peer is ${peer.trustStatus}`, checkedAt: new Date().toISOString() };
    try {
      await this.driver.resolveAgentCard(peer.cardUrl);
      return { ok: true, message: "A2A Agent Card reachable", checkedAt: new Date().toISOString() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
    }
  }
  async createSession(agent: RegisteredAgent, options: AgentSessionOptions): Promise<AgentSession> {
    const peer = this.peer(agent.id);
    if (peer.trustStatus !== "trusted") throw new Error(`A2A peer ${agent.id} is ${peer.trustStatus}`);
    const session: AgentSession = { id: `a2a-${++this.sessionCounter}`, agentId: agent.id, createdAt: new Date().toISOString() };
    this.sessions.set(session.id, { agentId: agent.id, options, taskId: undefined });
    return session;
  }
  async send(session: AgentSession, request: AgentRequest, context: AgentContext): Promise<AgentResponse> {
    const state = this.sessions.get(session.id);
    if (!state) throw new Error(`Unknown A2A session ${session.id}`);
    const peer = this.peer(state.agentId);
    if (peer.trustStatus !== "trusted") throw new Error(`A2A peer ${state.agentId} is ${peer.trustStatus}`);
    const localTaskId = context.taskId ?? state.options.taskId;
    const outbound = createOutboundRequest(this.options.nodeId, state, request, context, localTaskId);

    try {
      let response: AgentResponse;
      let remoteTaskId: string | undefined;
      if (peer.card.capabilities?.streaming === true && this.driver.sendMessageStream) {
        const streamed = await this.consumeStream(peer, state.agentId, outbound, context, localTaskId);
        response = streamed.response;
        remoteTaskId = streamed.remoteTaskId;
      } else {
        const result = await this.driver.sendMessage(peer.card, outbound, context.signal);
        remoteTaskId = resultTaskId(result);
        response = normalizeResult(result);
      }
      if (remoteTaskId) state.taskId = remoteTaskId;
      this.options.events.publish("federation.task_sent", {
        agentId: state.agentId,
        remoteTaskId,
        localTaskId,
        contextId: context.conversationId,
        protocolVersion: preferredProtocolVersion(peer.card),
      }, { conversationId: context.conversationId, ...(localTaskId ? { taskId: localTaskId } : {}), agentId: state.agentId });
      return response;
    } catch (error) {
      this.options.events.publish("federation.failed", {
        direction: "outbound", agentId: state.agentId, contextId: context.conversationId,
        message: error instanceof Error ? error.message : String(error),
      }, { conversationId: context.conversationId, ...(localTaskId ? { taskId: localTaskId } : {}), agentId: state.agentId });
      throw error;
    }
  }
  async cancel(executionId: string): Promise<void> {
    const state = this.sessions.get(executionId);
    if (state?.taskId) await this.driver.cancelTask(this.peer(state.agentId).card, state.taskId);
  }
  async terminateSession(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
  async resolveAndStorePeer(agentId: string, cardUrl: string, trustStatus: PeerTrust, signal?: AbortSignal): Promise<AgentCard> {
    const discoveryUrl = validateRemoteUrl(cardUrl);
    const card = await this.driver.resolveAgentCard(discoveryUrl.toString(), signal);
    const currentInterfaces = card.supportedInterfaces.filter((item) => item.protocolVersion === A2A_PROTOCOL_VERSION);
    if (currentInterfaces.length === 0) throw new Error(`A2A peer ${agentId} does not advertise protocol ${A2A_PROTOCOL_VERSION}`);
    for (const item of currentInterfaces) {
      const interfaceUrl = validateRemoteUrl(item.url);
      assertSameA2aOrigin(discoveryUrl, interfaceUrl);
    }
    this.peers.set(agentId, { cardUrl: discoveryUrl.toString(), card: structuredClone(card), trustStatus });
    return structuredClone(card);
  }
  setPeerTrust(agentId: string, trustStatus: PeerTrust): void {
    const peer = this.peer(agentId);
    peer.trustStatus = trustStatus;
  }
  private peer(agentId: string): PeerState {
    const peer = this.peers.get(agentId);
    if (!peer) throw new Error(`Unknown A2A peer ${agentId}`);
    return peer;
  }

  private async consumeStream(
    peer: PeerState,
    agentId: string,
    request: SendMessageRequest,
    context: AgentContext,
    localTaskId: string | undefined,
  ): Promise<{ response: AgentResponse; remoteTaskId: string | undefined }> {
    const content: MessagePart[] = [];
    let remoteTaskId: string | undefined;
    let lastState: unknown;
    for await (const event of this.driver.sendMessageStream!(peer.card, request, context.signal)) {
      const payload = event.payload;
      if (!payload) continue;
      switch (payload.$case) {
        case "task": {
          remoteTaskId = payload.value.id || remoteTaskId;
          lastState = payload.value.status?.state;
          appendUniqueParts(content, payload.value.status?.message ? mapParts(payload.value.status.message.parts) : []);
          for (const artifact of payload.value.artifacts) appendUniqueParts(content, mapParts(artifact.parts));
          this.publishProgress(agentId, context, localTaskId, {
            kind: "task",
            remoteTaskId: payload.value.id,
            contextId: payload.value.contextId,
            state: payload.value.status?.state,
          });
          break;
        }
        case "message": {
          remoteTaskId = payload.value.taskId || remoteTaskId;
          appendUniqueParts(content, mapParts(payload.value.parts));
          this.publishProgress(agentId, context, localTaskId, {
            kind: "message",
            remoteTaskId: payload.value.taskId || undefined,
            contextId: payload.value.contextId,
            content: mapParts(payload.value.parts),
          });
          break;
        }
        case "statusUpdate": {
          remoteTaskId = payload.value.taskId || remoteTaskId;
          lastState = payload.value.status?.state;
          const parts = payload.value.status?.message ? mapParts(payload.value.status.message.parts) : [];
          appendUniqueParts(content, parts);
          this.publishProgress(agentId, context, localTaskId, {
            kind: "statusUpdate",
            remoteTaskId: payload.value.taskId,
            contextId: payload.value.contextId,
            state: payload.value.status?.state,
            ...(parts.length ? { content: parts } : {}),
          });
          break;
        }
        case "artifactUpdate": {
          remoteTaskId = payload.value.taskId || remoteTaskId;
          const parts = payload.value.artifact ? mapParts(payload.value.artifact.parts) : [];
          appendUniqueParts(content, parts);
          this.publishProgress(agentId, context, localTaskId, {
            kind: "artifactUpdate",
            remoteTaskId: payload.value.taskId,
            contextId: payload.value.contextId,
            artifactId: payload.value.artifact?.artifactId,
            artifactName: payload.value.artifact?.name,
            append: payload.value.append,
            lastChunk: payload.value.lastChunk,
            ...(parts.length ? { content: parts } : {}),
          });
          break;
        }
      }
    }
    if (!content.length) content.push({ type: "json", value: { taskId: remoteTaskId, state: lastState } });
    return {
      response: { content, artifacts: [], ...(remoteTaskId ? { vendorMessageId: remoteTaskId } : {}) },
      remoteTaskId,
    };
  }

  private publishProgress(
    agentId: string,
    context: AgentContext,
    localTaskId: string | undefined,
    data: Record<string, unknown>,
  ): void {
    this.options.events.publish("federation.task_progress", {
      agentId,
      localTaskId,
      ...data,
    }, {
      conversationId: context.conversationId,
      ...(localTaskId ? { taskId: localTaskId } : {}),
      agentId,
    });
  }
}

export interface RegisterRemoteA2aPeerOptions {
  registry: Pick<A2aRegistry, "register">;
  adapter: A2aRemoteAdapter;
  nodeId: string;
  agentId: string;
  cardUrl: string;
  trustStatus?: PeerTrust;
  signal?: AbortSignal;
}

export async function registerRemoteA2aPeer(options: RegisterRemoteA2aPeerOptions): Promise<RegisteredAgent> {
  const id = options.agentId.trim();
  if (!id || id.startsWith("human:")) throw new Error("Remote A2A agent id must be a non-human identifier");
  const trustStatus = options.trustStatus ?? "pending-trust";
  const card = await options.adapter.resolveAndStorePeer(id, options.cardUrl, trustStatus, options.signal);
  return options.registry.register({
    id,
    nodeId: options.nodeId,
    canonicalUri: card.supportedInterfaces[0]?.url ?? options.cardUrl,
    name: card.name,
    adapterType: options.adapter.type,
    capabilities: unique(card.skills.map((skill) => skill.id)),
    status: trustStatus === "trusted" ? "idle" : trustStatus === "disabled" ? "disabled" : "degraded",
    ephemeral: false,
    metadata: {
      source: "a2a-agent-card", cardUrl: options.cardUrl, protocolVersion: preferredProtocolVersion(card), transportTypes: ["a2a"], trustStatus,
      supportsA2a: true, supportsStreaming: card.capabilities?.streaming === true, supportsSessions: true, supportsCancellation: true, supportsTools: false,
    },
  });
}

function createOutboundRequest(
  nodeId: string,
  state: SessionState,
  request: AgentRequest,
  context: AgentContext,
  localTaskId: string | undefined,
): SendMessageRequest {
  return {
    tenant: "",
    message: {
      role: Role.ROLE_USER,
      messageId: randomUUID(),
      contextId: context.conversationId,
      // A2A task identifiers are owned by the remote server. Only send one when continuing a task it assigned earlier.
      taskId: state.taskId ?? "",
      parts: request.content.map(internalPartToA2a),
      metadata: {
        "agent2agent.originNodeId": nodeId,
        "agent2agent.intent": request.intent,
        ...(localTaskId ? { "agent2agent.localTaskId": localTaskId } : {}),
      },
      extensions: [], referenceTaskIds: [],
    },
    configuration: { acceptedOutputModes: ["text"], returnImmediately: false, taskPushNotificationConfig: undefined },
    metadata: {},
  };
}

function resultTaskId(result: SendMessageResult): string | undefined {
  return "id" in result ? result.id : result.taskId || undefined;
}

function normalizeResult(result: SendMessageResult): AgentResponse {
  if ("messageId" in result) return { content: mapParts(result.parts), artifacts: [], vendorMessageId: result.messageId };
  const content: MessagePart[] = [];
  if (result.status?.message) content.push(...mapParts(result.status.message.parts));
  for (const artifact of result.artifacts) content.push(...mapParts(artifact.parts));
  if (!content.length) content.push({ type: "json", value: { taskId: result.id, state: result.status?.state } });
  return { content, artifacts: [], vendorMessageId: result.id };
}
function mapParts(parts: Part[]): MessagePart[] {
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
function appendUniqueParts(target: MessagePart[], parts: MessagePart[]): void {
  const seen = new Set(target.map((part) => JSON.stringify(part)));
  for (const part of parts) {
    const key = JSON.stringify(part);
    if (seen.has(key)) continue;
    target.push(part);
    seen.add(key);
  }
}
function internalPartToA2a(part: MessagePart): Part {
  if (part.type === "text") return a2aTextPart(part.text);
  if (part.type === "reference") return { content: { $case: "url", value: part.uri }, mediaType: part.mediaType ?? "application/octet-stream", filename: "", metadata: {} };
  return { content: { $case: "data", value: recordValue(part.value) }, mediaType: "application/json", filename: "", metadata: {} };
}
