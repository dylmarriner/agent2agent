import { useEffect, useMemo, useState } from "react";
import {
  createConversation,
  fetchAgents,
  fetchConversations,
  fetchEvents,
  fetchHealth,
  fetchMessages,
  sendMessage,
  subscribeEvents,
  updateTrust,
  type AgentDto,
  type ConversationDto,
  type EventDto,
  type HealthDto,
  type MessageDto,
  type TrustStatus,
} from "./api.js";
import { AgentDirectory } from "./components/AgentDirectory.js";
import { ConversationViewer } from "./components/ConversationViewer.js";
import { CreateConversation } from "./components/CreateConversation.js";
import { NetworkGraph } from "./components/NetworkGraph.js";

export function App() {
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [events, setEvents] = useState<EventDto[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId),
    [conversations, selectedConversationId],
  );

  const refreshAgents = async () => {
    const next = await fetchAgents();
    setAgents(next);
    setSelectedAgentIds((current) => {
      if (current.size > 0) return new Set([...current].filter((id) => next.some((agent) => agent.id === id)));
      return new Set(next.filter((agent) => agent.trustStatus === "trusted" && agent.status !== "offline").map((agent) => agent.id));
    });
  };

  const refreshConversations = async () => {
    const next = await fetchConversations();
    setConversations(next);
    setSelectedConversationId((current) => current ?? next.at(-1)?.id ?? null);
  };

  const refreshMessages = async (conversationId: string | null) => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    setMessages(await fetchMessages(conversationId));
  };

  useEffect(() => {
    let active = true;
    void Promise.all([fetchHealth(), fetchAgents(), fetchConversations(), fetchEvents()])
      .then(([nextHealth, nextAgents, nextConversations, nextEvents]) => {
        if (!active) return;
        setHealth(nextHealth);
        setAgents(nextAgents);
        setConversations(nextConversations);
        setEvents(nextEvents.slice(-100));
        setSelectedAgentIds(new Set(nextAgents.filter((agent) => agent.trustStatus === "trusted" && agent.status !== "offline").map((agent) => agent.id)));
        setSelectedConversationId(nextConversations.at(-1)?.id ?? null);
      })
      .catch((cause: unknown) => active && setError(errorMessage(cause)));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    void refreshMessages(selectedConversationId).catch((cause: unknown) => setError(errorMessage(cause)));
  }, [selectedConversationId]);

  useEffect(() => {
    const unsubscribe = subscribeEvents((event) => {
      setEvents((current) => [...current.filter((entry) => entry.id !== event.id), event].slice(-100));
      if (event.type.startsWith("agent.") || event.type.startsWith("package.")) {
        void refreshAgents().catch((cause: unknown) => setError(errorMessage(cause)));
      }
      if (event.type.startsWith("conversation.")) {
        void refreshConversations().catch((cause: unknown) => setError(errorMessage(cause)));
      }
      if (event.type.startsWith("message.") && event.conversationId === selectedConversationId) {
        void refreshMessages(selectedConversationId).catch((cause: unknown) => setError(errorMessage(cause)));
      }
      void fetchHealth().then(setHealth).catch(() => {});
    }, setConnected);
    return unsubscribe;
  }, [selectedConversationId]);

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const changeTrust = async (agentId: string, trustStatus: TrustStatus) => {
    setError(null);
    try {
      const updated = await updateTrust(agentId, trustStatus);
      setAgents((current) => current.map((agent) => agent.id === updated.id ? updated : agent));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const startConversation = async (input: { title: string; objective: string; participantIds: string[] }) => {
    setCreating(true);
    setError(null);
    try {
      const conversation = await createConversation(input);
      setConversations((current) => [...current, conversation]);
      setSelectedConversationId(conversation.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  };

  const send = async (text: string) => {
    if (!selectedConversationId) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage(selectedConversationId, text);
      await refreshMessages(selectedConversationId);
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">A2A</span>
          <div>
            <h1>Agent2Agent</h1>
            <p>Collective control center</p>
          </div>
        </div>
        <div className="runtime-status">
          <span className={`connection ${connected ? "online" : "offline"}`}><i />{connected ? "Live" : "Reconnecting"}</span>
          <span>{health?.nodeId ?? "local"}</span>
          <span>{health?.agents ?? agents.length} agents</span>
          <span>{health?.events ?? events.length} events</span>
        </div>
      </header>

      {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}

      <main className="control-grid">
        <AgentDirectory agents={agents} selectedIds={selectedAgentIds} onToggle={toggleAgent} onTrust={changeTrust} />

        <div className="workspace-column">
          <div className="conversation-tabs panel" aria-label="Conversations">
            <div className="tabs-scroll">
              {conversations.map((conversation) => (
                <button
                  type="button"
                  key={conversation.id}
                  className={conversation.id === selectedConversationId ? "active" : ""}
                  onClick={() => setSelectedConversationId(conversation.id)}
                >
                  <strong>{conversation.title}</strong>
                  <span>{conversation.status}</span>
                </button>
              ))}
              {conversations.length === 0 && <span className="no-conversations">No conversations yet</span>}
            </div>
          </div>

          <ConversationViewer
            {...(selectedConversation ? { conversation: selectedConversation } : {})}
            messages={messages}
            agents={agents}
            sending={sending}
            onSend={send}
          />
        </div>

        <div className="inspector-column">
          <CreateConversation agents={agents} selectedAgentIds={selectedAgentIds} creating={creating} onCreate={startConversation} />
          <NetworkGraph {...(selectedConversation ? { conversation: selectedConversation } : {})} agents={agents} messages={messages} />
          <section className="activity panel">
            <div className="panel-heading"><div><h2>Live activity</h2><p>Last {Math.min(events.length, 100)} canonical events</p></div></div>
            <div className="activity-list">
              {[...events].reverse().slice(0, 20).map((event) => (
                <div className="activity-row" key={event.id}>
                  <span className="activity-type">{event.type}</span>
                  <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time>
                </div>
              ))}
              {events.length === 0 && <div className="empty-state">No runtime events received yet.</div>}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
