import { FormEvent, useMemo, useState } from "react";
import type { AgentDto, ConversationDto, MessageDto } from "../api.js";

export interface ConversationViewerProps {
  conversation?: ConversationDto;
  messages: MessageDto[];
  agents: AgentDto[];
  sending: boolean;
  onSend(text: string): Promise<void>;
}

export function ConversationViewer({ conversation, messages, agents, sending, onSend }: ConversationViewerProps) {
  const [text, setText] = useState("");
  const names = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!conversation || !value || sending) return;
    setText("");
    try {
      await onSend(value);
    } catch {
      setText(value);
    }
  };

  if (!conversation) {
    return (
      <section className="conversation panel empty-conversation">
        <div>
          <h2>No conversation selected</h2>
          <p>Create a conversation or select one from the activity rail to start observing real agent traffic.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="conversation panel">
      <header className="conversation-header">
        <div>
          <p className="conversation-objective">{conversation.objective}</p>
          <h2>{conversation.title}</h2>
        </div>
        <div className="conversation-state">
          <span>{conversation.status}</span>
          <small>{conversation.participantIds.length} participants</small>
        </div>
      </header>

      <div className="transcript" role="log" aria-live="polite">
        {messages.map((message) => {
          const textParts = message.content.filter((part) => part.type === "text").map((part) => part.text ?? "");
          const senderName = message.senderAgentId.startsWith("human:") ? "You" : names.get(message.senderAgentId) ?? message.senderAgentId;
          return (
            <article className={`message ${message.senderAgentId.startsWith("human:") ? "message-human" : "message-agent"}`} key={message.id}>
              <div className="message-route">
                <strong>{senderName}</strong>
                <span>→</span>
                <span>{message.recipientAgentIds.map((id) => id.startsWith("human:") ? "You" : names.get(id) ?? id).join(", ")}</span>
                <span className="intent">{message.intent}</span>
              </div>
              <div className="message-body">{textParts.join("\n") || "(structured response)"}</div>
              <footer>
                <span>#{message.sequence}</span>
                <span>round {message.round}</span>
                <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString()}</time>
              </footer>
            </article>
          );
        })}
        {messages.length === 0 && <div className="empty-state transcript-empty">No messages yet. The transcript will only show activity emitted by the runtime.</div>}
      </div>

      <form className="composer" onSubmit={(event) => void submit(event)}>
        <textarea
          aria-label="Message agents"
          placeholder="Message @collective, @claude-local, @codex-local…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
        />
        <div className="composer-footer">
          <span>Use @collective for routing or @agent-id for direct control.</span>
          <button type="submit" disabled={sending || !text.trim()}>{sending ? "Working…" : "Send"}</button>
        </div>
      </form>
    </section>
  );
}
