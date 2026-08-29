import type { AgentAdapter, AgentMessage, AgentSession, RegisteredAgent } from "../../protocol/src/index.js";
import type { EventStore } from "../../core/src/index.js";
import type { ConversationRuntime } from "./index.js";

export interface ConversationDispatchRegistry {
  get(id: string): RegisteredAgent;
  adapterFor(agentId: string): AgentAdapter;
}

export interface ConversationDispatcherOptions {
  registry: ConversationDispatchRegistry;
  conversations: ConversationRuntime;
  events: EventStore;
  maxAgentHops?: number;
  maxActiveSessions?: number;
}

interface CachedDispatchSession {
  adapter: AgentAdapter;
  session: AgentSession;
  lastUsed: number;
}

export class ConversationDispatcher {
  private readonly sessions = new Map<string, CachedDispatchSession>();
  private readonly sessionCreations = new Map<string, Promise<CachedDispatchSession>>();
  private readonly maxAgentHops: number;
  private readonly maxActiveSessions: number;
  private useCounter = 0;
  private closing = false;

  constructor(private readonly options: ConversationDispatcherOptions) {
    this.maxAgentHops = options.maxAgentHops ?? 6;
    this.maxActiveSessions = options.maxActiveSessions ?? 64;
    if (!Number.isInteger(this.maxAgentHops) || this.maxAgentHops < 1) throw new Error("Conversation max agent hops must be a positive integer");
    if (!Number.isInteger(this.maxActiveSessions) || this.maxActiveSessions < 1) throw new Error("Conversation max active sessions must be a positive integer");
  }

  async dispatch(message: AgentMessage, options: { signal?: AbortSignal; hop?: number } = {}): Promise<AgentMessage[]> {
    if (this.closing) throw new Error("Conversation dispatcher is closing");
    const hop = options.hop ?? 0;
    if (hop >= this.maxAgentHops) throw new Error(`Conversation agent hop limit reached: ${this.maxAgentHops}`);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Conversation dispatch aborted");

    const produced: AgentMessage[] = [];
    for (const recipientId of message.recipientAgentIds) {
      if (recipientId.startsWith("human:")) continue;
      const reply = await this.invokeRecipient(message, recipientId, options.signal);
      produced.push(reply);
      const explicitRecipients = await this.explicitAgentMentions(reply);
      if (explicitRecipients.length > 0) {
        const nested = await this.dispatch(reply, { ...(options.signal ? { signal: options.signal } : {}), hop: hop + 1 });
        produced.push(...nested);
      }
    }
    return produced;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.sessionCreations.values()]);
    const active = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(active.map((entry) => entry.adapter.terminateSession?.(entry.session.id)));
  }

  private async invokeRecipient(message: AgentMessage, recipientId: string, signal?: AbortSignal): Promise<AgentMessage> {
    const agent = this.options.registry.get(recipientId);
    const adapter = this.options.registry.adapterFor(recipientId);
    const key = `${message.conversationId}\u0000${recipientId}`;
    const cached = await this.acquireSession(key, agent, adapter, message);

    try {
      const response = await adapter.send(
        cached.session,
        {
          intent: message.intent,
          content: message.content.map((part) => structuredClone(part)),
          artifacts: message.artifacts.map((artifact) => structuredClone(artifact)),
        },
        {
          conversationId: message.conversationId,
          ...(message.taskId ? { taskId: message.taskId } : {}),
          ...(signal ? { signal } : {}),
          metadata: {
            senderAgentId: message.senderAgentId,
            parentMessageId: message.id,
          },
        },
      );
      cached.lastUsed = ++this.useCounter;
      this.options.events.publish("message.delivered", {
        messageId: message.id,
        recipientAgentId: recipientId,
      }, {
        conversationId: message.conversationId,
        ...(message.taskId ? { taskId: message.taskId } : {}),
        agentId: recipientId,
      });

      const responseText = response.content
        .map((part) => part.type === "text" ? part.text : part.type === "json" ? JSON.stringify(part.value) : part.uri)
        .join("\n\n")
        .trim();
      const explicitRecipients = await this.parseExplicitMentions(message.conversationId, responseText, recipientId);
      const recipients = explicitRecipients.length > 0 ? explicitRecipients : [message.senderAgentId];
      return this.options.conversations.sendAgentMessage(message.conversationId, {
        senderAgentId: recipientId,
        recipientAgentIds: recipients,
        text: responseText || "(no textual response)",
        intent: message.intent,
        ...(message.taskId ? { taskId: message.taskId } : {}),
        parentMessageId: message.id,
      });
    } catch (error) {
      if (this.sessions.get(key)?.session.id === cached.session.id) this.sessions.delete(key);
      await adapter.terminateSession?.(cached.session.id);
      throw error;
    }
  }

  private async acquireSession(
    key: string,
    agent: RegisteredAgent,
    adapter: AgentAdapter,
    message: AgentMessage,
  ): Promise<CachedDispatchSession> {
    const cached = this.sessions.get(key);
    if (cached) {
      cached.lastUsed = ++this.useCounter;
      return cached;
    }
    const inFlight = this.sessionCreations.get(key);
    if (inFlight) {
      const created = await inFlight;
      created.lastUsed = ++this.useCounter;
      return created;
    }

    await this.reserveSessionCapacity();
    if (this.closing) throw new Error("Conversation dispatcher is closing");

    const creation = (async (): Promise<CachedDispatchSession> => {
      const session = await adapter.createSession(agent, {
        conversationId: message.conversationId,
        ...(message.taskId ? { taskId: message.taskId } : {}),
      });
      if (this.closing) {
        await adapter.terminateSession?.(session.id);
        throw new Error("Conversation dispatcher closed during session creation");
      }
      const created = { adapter, session, lastUsed: ++this.useCounter };
      this.sessions.set(key, created);
      return created;
    })();
    this.sessionCreations.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.sessionCreations.get(key) === creation) this.sessionCreations.delete(key);
    }
  }

  private async reserveSessionCapacity(): Promise<void> {
    while (this.sessions.size + this.sessionCreations.size >= this.maxActiveSessions) {
      if (this.sessions.size > 0) {
        await this.evictOldest();
        continue;
      }
      const pending = [...this.sessionCreations.values()];
      if (pending.length === 0) break;
      await Promise.race(pending).catch(() => {});
      if (this.closing) throw new Error("Conversation dispatcher is closing");
    }
  }

  private async explicitAgentMentions(message: AgentMessage): Promise<string[]> {
    const text = message.content
      .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return this.parseExplicitMentions(message.conversationId, text, message.senderAgentId);
  }

  private async parseExplicitMentions(conversationId: string, text: string, senderId: string): Promise<string[]> {
    const conversation = await this.options.conversations.get(conversationId);
    const allowed = new Set(conversation.participantIds.filter((id) => id !== senderId && !id.startsWith("human:")));
    const mentions = [...text.matchAll(/@([A-Za-z0-9:_-]+)/g)].map((match) => match[1]!).filter((id) => allowed.has(id));
    return [...new Set(mentions)];
  }

  private async evictOldest(): Promise<void> {
    let oldestKey: string | undefined;
    let oldest: CachedDispatchSession | undefined;
    for (const [key, value] of this.sessions) {
      if (!oldest || value.lastUsed < oldest.lastUsed) {
        oldestKey = key;
        oldest = value;
      }
    }
    if (!oldestKey || !oldest) return;
    this.sessions.delete(oldestKey);
    await oldest.adapter.terminateSession?.(oldest.session.id);
  }
}
