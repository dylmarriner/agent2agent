import type { AgentMessage, CollaborationIntent, MessagePart } from "../../protocol/src/index.js";
import { CollectiveError, type EventStore, type IdFactory } from "../../core/src/index.js";

export type ConversationStatus = "created" | "active" | "paused" | "completed" | "failed";

export interface ConversationRecord {
  id: string;
  nodeId: string;
  title: string;
  objective: string;
  status: ConversationStatus;
  participantIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateConversationInput {
  title: string;
  objective: string;
  participantIds: string[];
}

export interface HumanMessageInput {
  text: string;
  taskId?: string;
  intent?: CollaborationIntent;
}

export interface AgentConversationMessageInput {
  senderAgentId: string;
  recipientAgentIds: string[];
  text: string;
  intent: CollaborationIntent;
  taskId?: string;
  parentMessageId?: string;
}

export interface ConversationRepository {
  saveConversation(record: ConversationRecord): Promise<void>;
  getConversation(id: string): Promise<ConversationRecord | undefined>;
  listConversations(): Promise<ConversationRecord[]>;
  appendMessage(message: AgentMessage): Promise<void>;
  listMessages(conversationId: string): Promise<AgentMessage[]>;
}

export class InMemoryConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly messagesByConversation = new Map<string, AgentMessage[]>();

  async saveConversation(record: ConversationRecord): Promise<void> {
    this.conversations.set(record.id, structuredClone(record));
  }

  async getConversation(id: string): Promise<ConversationRecord | undefined> {
    const record = this.conversations.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async listConversations(): Promise<ConversationRecord[]> {
    return [...this.conversations.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((record) => structuredClone(record));
  }

  async appendMessage(message: AgentMessage): Promise<void> {
    const messages = this.messagesByConversation.get(message.conversationId) ?? [];
    messages.push(structuredClone(message));
    this.messagesByConversation.set(message.conversationId, messages);
  }

  async listMessages(conversationId: string): Promise<AgentMessage[]> {
    return (this.messagesByConversation.get(conversationId) ?? [])
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((message) => structuredClone(message));
  }
}

export interface ConversationRuntimeOptions {
  nodeId: string;
  id: IdFactory;
  events: EventStore;
  repository: ConversationRepository;
  humanParticipantId?: string;
}

export class ConversationRuntime {
  private readonly humanParticipantId: string;

  constructor(private readonly options: ConversationRuntimeOptions) {
    this.humanParticipantId = options.humanParticipantId ?? "human:operator";
  }

  async create(input: CreateConversationInput): Promise<ConversationRecord> {
    const now = new Date().toISOString();
    const participantIds = unique([this.humanParticipantId, ...input.participantIds]);
    if (participantIds.length < 2) throw new CollectiveError("conversation_participants", "Conversation requires at least one non-human participant");
    const record: ConversationRecord = {
      id: this.options.id("conversation"),
      nodeId: this.options.nodeId,
      title: input.title.trim(),
      objective: input.objective.trim(),
      status: "created",
      participantIds,
      createdAt: now,
      updatedAt: now,
    };
    if (!record.title) throw new CollectiveError("conversation_title", "Conversation title is required");
    if (!record.objective) throw new CollectiveError("conversation_objective", "Conversation objective is required");
    await this.options.repository.saveConversation(record);
    this.options.events.publish("conversation.created", {
      conversationId: record.id,
      title: record.title,
      objective: record.objective,
      participantIds: [...record.participantIds],
    }, { conversationId: record.id });
    return structuredClone(record);
  }

  async list(): Promise<ConversationRecord[]> {
    return this.options.repository.listConversations();
  }

  async get(id: string): Promise<ConversationRecord> {
    return this.requireConversation(id);
  }

  async messages(id: string): Promise<AgentMessage[]> {
    await this.requireConversation(id);
    return this.options.repository.listMessages(id);
  }

  async sendHumanMessage(conversationId: string, input: HumanMessageInput): Promise<AgentMessage> {
    const conversation = await this.requireConversation(conversationId);
    const text = input.text.trim();
    if (!text) throw new CollectiveError("message_empty", "Message text is required");
    const recipientAgentIds = parseHumanRecipients(text, conversation.participantIds, this.humanParticipantId);
    if (recipientAgentIds.length === 0) throw new CollectiveError("message_recipients", "No routable conversation participants matched this message");
    return this.persistAndRoute({
      conversation,
      senderAgentId: this.humanParticipantId,
      recipientAgentIds,
      text,
      intent: input.intent ?? "ask",
      ...(input.taskId ? { taskId: input.taskId } : {}),
    });
  }

  async sendAgentMessage(conversationId: string, input: AgentConversationMessageInput): Promise<AgentMessage> {
    const conversation = await this.requireConversation(conversationId);
    if (!conversation.participantIds.includes(input.senderAgentId)) {
      throw new CollectiveError("conversation_sender", `Agent ${input.senderAgentId} is not a participant in ${conversationId}`);
    }
    for (const recipient of input.recipientAgentIds) {
      if (!conversation.participantIds.includes(recipient)) {
        throw new CollectiveError("conversation_recipient", `Recipient ${recipient} is not a participant in ${conversationId}`);
      }
    }
    const text = input.text.trim();
    if (!text) throw new CollectiveError("message_empty", "Message text is required");
    return this.persistAndRoute({
      conversation,
      senderAgentId: input.senderAgentId,
      recipientAgentIds: unique(input.recipientAgentIds),
      text,
      intent: input.intent,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
    });
  }

  private async persistAndRoute(input: {
    conversation: ConversationRecord;
    senderAgentId: string;
    recipientAgentIds: string[];
    text: string;
    intent: CollaborationIntent;
    taskId?: string;
    parentMessageId?: string;
  }): Promise<AgentMessage> {
    const existing = await this.options.repository.listMessages(input.conversation.id);
    const content: MessagePart[] = [{ type: "text", text: input.text }];
    const message: AgentMessage = {
      id: this.options.id("message"),
      conversationId: input.conversation.id,
      senderAgentId: input.senderAgentId,
      recipientAgentIds: [...input.recipientAgentIds],
      intent: input.intent,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
      correlationId: this.options.id("correlation"),
      round: 0,
      sequence: existing.length + 1,
      content,
      artifacts: [],
      routingMetadata: {
        originNodeId: this.options.nodeId,
        currentNodeId: this.options.nodeId,
        hopCount: 0,
        visitedNodeIds: [this.options.nodeId],
      },
      createdAt: new Date().toISOString(),
    };

    await this.options.repository.appendMessage(message);
    this.options.events.publish("message.created", {
      messageId: message.id,
      senderAgentId: message.senderAgentId,
      recipientAgentIds: [...message.recipientAgentIds],
      sequence: message.sequence,
    }, {
      conversationId: message.conversationId,
      ...(message.taskId ? { taskId: message.taskId } : {}),
      ...(message.senderAgentId.startsWith("human:") ? {} : { agentId: message.senderAgentId }),
    });
    this.options.events.publish("message.routed", {
      messageId: message.id,
      recipientAgentIds: [...message.recipientAgentIds],
    }, {
      conversationId: message.conversationId,
      ...(message.taskId ? { taskId: message.taskId } : {}),
    });
    return structuredClone(message);
  }

  private async requireConversation(id: string): Promise<ConversationRecord> {
    const conversation = await this.options.repository.getConversation(id);
    if (!conversation) throw new CollectiveError("conversation_not_found", `Unknown conversation ${id}`);
    return conversation;
  }
}

function parseHumanRecipients(text: string, participantIds: string[], humanParticipantId: string): string[] {
  const routable = participantIds.filter((participantId) => participantId !== humanParticipantId);
  const mentions = [...text.matchAll(/@([A-Za-z0-9:_-]+)/g)].map((match) => match[1]!).filter(Boolean);
  if (mentions.length === 0 || mentions.includes("collective")) return routable;
  const recipients = unique(mentions.filter((mention) => routable.includes(mention)));
  return recipients;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
