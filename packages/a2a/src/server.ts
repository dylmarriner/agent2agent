import { randomUUID } from "node:crypto";
import {
  A2A_PROTOCOL_VERSION,
  Role,
  TaskState,
  type AgentCard,
  type Artifact,
  type Message,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import type { EventStore } from "../../core/src/index.js";
import type { ConversationDispatcher } from "../../conversation/src/dispatcher.js";
import type { ConversationRuntime } from "../../conversation/src/index.js";
import type { CollaborationIntent, MessagePart, RegisteredAgent } from "../../protocol/src/index.js";
import { a2aTextPart, normalizeBaseUrl, recordValue, trustStatus, unique, type A2aRegistry } from "./common.js";

export interface CreateCollectiveAgentCardOptions {
  nodeId: string;
  baseUrl: string;
  registry: Pick<A2aRegistry, "list">;
  name?: string;
  description?: string;
}

/** Builds an A2A v1 Agent Card from trusted local capabilities. */
export function createCollectiveAgentCard(options: CreateCollectiveAgentCardOptions): AgentCard {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const localAgents = options.registry.list()
    .filter((agent) => agent.adapterType !== "a2a" && agent.status !== "disabled")
    .filter((agent) => trustStatus(agent) === "trusted");
  return {
    name: options.name ?? `Agent2Agent Collective (${options.nodeId})`,
    description: options.description ?? "Federated collective of locally registered AI agents.",
    supportedInterfaces: [{ url: `${baseUrl}/a2a`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: "Agent2Agent", url: baseUrl },
    version: "0.1.0",
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
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
        examples: [], inputModes: ["text"], outputModes: ["text"], securityRequirements: [],
      },
      ...localAgents.map((agent) => ({
        id: `agent:${agent.id}`,
        name: agent.name,
        description: `Delegate work to ${agent.name} through the Agent2Agent collective.`,
        tags: unique(agent.capabilities),
        examples: [], inputModes: ["text"], outputModes: ["text"], securityRequirements: [],
      })),
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

interface ActiveInboundTask { controller: AbortController; contextId: string; }

/** Converts inbound A2A work into canonical conversation traffic and emits A2A task updates. */
export class CollectiveA2aExecutor implements AgentExecutor {
  private readonly active = new Map<string, ActiveInboundTask>();
  constructor(private readonly options: CollectiveA2aExecutorOptions) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;
    assertExternalId(taskId, "A2A task id");
    assertExternalId(contextId, "A2A context id");
    const controller = new AbortController();
    this.active.set(taskId, { controller, contextId });
    try {
      const text = a2aMessageText(userMessage);
      if (!text) throw new Error("Inbound A2A message must contain a non-empty text part");
      const metadata = recordValue(userMessage.metadata);
      const peerId = externalPeerId(metadata["agent2agent.peerId"]);
      const senderId = `a2a:${peerId}`;
      const intent = collaborationIntent(metadata["agent2agent.intent"]);
      const routable = this.routableLocalAgents();
      const requestedTargets = stringArray(metadata["agent2agent.targetAgentIds"]);
      const targetIds = requestedTargets.length
        ? requestedTargets.map((id) => this.requireRoutableTarget(id, routable).id)
        : routable.map((agent) => agent.id);
      if (!targetIds.length) throw new Error("No trusted local agents are available for inbound A2A work");

      const conversationId = `a2a:${contextId}`;
      await this.ensureConversation(conversationId, senderId, routable, text);
      const initialTask: Task = {
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
        artifacts: [], history: [structuredClone(userMessage)], metadata: userMessage.metadata,
      };
      eventBus.publish(AgentEvent.task(initialTask));
      eventBus.publish(AgentEvent.statusUpdate(statusUpdate(taskId, contextId, TaskState.TASK_STATE_WORKING)));
      this.options.events.publish("federation.task_received", {
        peerId, remoteTaskId: taskId, remoteContextId: contextId, targetAgentIds: [...targetIds],
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
        .filter(Boolean).join("\n\n").trim() || "Agent2Agent collective completed without a textual result.";
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
        taskId, contextId, artifact, lastChunk: true, append: false, metadata: undefined,
      };
      eventBus.publish(AgentEvent.artifactUpdate(artifactUpdate));
      eventBus.publish(AgentEvent.statusUpdate(statusUpdate(taskId, contextId, TaskState.TASK_STATE_COMPLETED)));
    } catch (error) {
      if (controller.signal.aborted) {
        eventBus.publish(AgentEvent.statusUpdate(statusUpdate(taskId, contextId, TaskState.TASK_STATE_CANCELED)));
        return;
      }
      this.options.events.publish("federation.failed", {
        direction: "inbound", remoteTaskId: taskId, remoteContextId: contextId,
        message: error instanceof Error ? error.message : String(error),
      }, { conversationId: `a2a:${contextId}`, taskId });
      eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
        taskId, contextId, TaskState.TASK_STATE_FAILED, error instanceof Error ? error.message : String(error),
      )));
    } finally {
      this.active.delete(taskId);
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const active = this.active.get(taskId);
    active?.controller.abort(new Error(`A2A task ${taskId} cancelled`));
    eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
      taskId, active?.contextId ?? "", TaskState.TASK_STATE_CANCELED,
    )));
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

  private async ensureConversation(conversationId: string, senderId: string, routable: RegisteredAgent[], objective: string): Promise<void> {
    const existing = (await this.options.conversations.list()).find((conversation) => conversation.id === conversationId);
    if (existing) {
      if (!existing.participantIds.includes(senderId)) throw new Error(`A2A context ${conversationId} belongs to a different remote peer`);
      return;
    }
    await this.options.conversations.create({
      id: conversationId,
      title: `A2A federation ${conversationId.slice(4)}`,
      objective: objective.slice(0, 500),
      participantIds: [senderId, ...routable.map((agent) => agent.id)],
    });
  }
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
        extensions: [], metadata: {}, referenceTaskIds: [],
      } : undefined,
    },
    metadata: {},
  };
}

function a2aMessageText(message: Message): string {
  return message.parts.filter((part) => part.content?.$case === "text")
    .map((part) => part.content?.$case === "text" ? part.content.value : "").join("\n").trim();
}
function messagePartText(part: MessagePart): string {
  return part.type === "text" ? part.text : part.type === "json" ? JSON.stringify(part.value) : part.uri;
}
function collaborationIntent(value: unknown): CollaborationIntent {
  const allowed = new Set<CollaborationIntent>([
    "ask", "delegate", "research", "review", "critique", "verify", "test", "debug", "improve", "compare", "challenge",
    "teach", "summarize", "vote", "synthesize", "spawn-specialist", "merge-findings", "request-memory", "publish-knowledge", "request-skill",
  ]);
  return typeof value === "string" && allowed.has(value as CollaborationIntent) ? value as CollaborationIntent : "delegate";
}
function externalPeerId(value: unknown): string {
  const peer = typeof value === "string" ? value.trim() : "remote";
  return peer && peer.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(peer) ? peer : "remote";
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? unique(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)) : [];
}
function assertExternalId(value: string, label: string): void {
  if (!value.trim() || value.length > 512) throw new Error(`${label} must be a non-empty string up to 512 characters`);
}
