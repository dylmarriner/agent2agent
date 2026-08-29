import { FormEvent, useMemo, useState } from "react";
import type { AgentDto } from "../api.js";

export interface CreateConversationProps {
  agents: AgentDto[];
  selectedAgentIds: Set<string>;
  creating: boolean;
  onCreate(input: { title: string; objective: string; participantIds: string[] }): Promise<void>;
}

export function CreateConversation({ agents, selectedAgentIds, creating, onCreate }: CreateConversationProps) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const routable = useMemo(
    () => agents.filter((agent) => agent.trustStatus === "trusted" && agent.status !== "offline" && agent.status !== "disabled"),
    [agents],
  );
  const selected = routable.filter((agent) => selectedAgentIds.has(agent.id));
  const participants = selected.length > 0 ? selected : routable;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !objective.trim() || participants.length === 0 || creating) return;
    await onCreate({
      title: title.trim(),
      objective: objective.trim(),
      participantIds: participants.map((agent) => agent.id),
    });
    setTitle("");
    setObjective("");
  };

  return (
    <form className="create-conversation panel" onSubmit={(event) => void submit(event)}>
      <div className="panel-heading">
        <div>
          <h2>New conversation</h2>
          <p>{selected.length > 0 ? `${selected.length} selected agents` : `${routable.length} trusted agents`}</p>
        </div>
      </div>
      <label>
        <span>Title</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Authentication review" />
      </label>
      <label>
        <span>Objective</span>
        <textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={3} placeholder="Have the collective inspect, challenge and verify the implementation." />
      </label>
      <button type="submit" disabled={creating || participants.length === 0 || !title.trim() || !objective.trim()}>
        {creating ? "Creating…" : "Start conversation"}
      </button>
    </form>
  );
}
