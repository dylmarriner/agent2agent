import type { AgentDto, TrustStatus } from "../api.js";

export interface AgentDirectoryProps {
  agents: AgentDto[];
  selectedIds: Set<string>;
  onToggle(agentId: string): void;
  onTrust(agentId: string, status: TrustStatus): Promise<void>;
}

export function AgentDirectory({ agents, selectedIds, onToggle, onTrust }: AgentDirectoryProps) {
  return (
    <aside className="agent-rail panel" aria-label="Agent directory">
      <div className="panel-heading">
        <div>
          <h2>Agents</h2>
          <p>{agents.length} detected runtimes</p>
        </div>
      </div>
      <div className="agent-list">
        {agents.map((agent) => (
          <article className={`agent-row ${selectedIds.has(agent.id) ? "is-selected" : ""}`} key={agent.id}>
            <button className="agent-main" type="button" onClick={() => onToggle(agent.id)}>
              <span className={`status-dot status-${agent.status}`} aria-hidden="true" />
              <span className="agent-copy">
                <strong>{agent.name}</strong>
                <span>{agent.id}</span>
              </span>
            </button>
            <div className="agent-meta">
              <span className={`trust trust-${agent.trustStatus}`}>{agent.trustStatus}</span>
              <div className="transport-list" aria-label={`${agent.name} transports`}>
                {agent.transportTypes.map((transport) => <span className="transport" key={transport}>{transport}</span>)}
              </div>
            </div>
            {agent.trustStatus === "pending-trust" && (
              <div className="trust-actions">
                <button type="button" onClick={() => void onTrust(agent.id, "trusted")}>Trust</button>
                <button type="button" className="quiet" onClick={() => void onTrust(agent.id, "disabled")}>Disable</button>
              </div>
            )}
            {agent.trustStatus === "trusted" && agent.supportsAcp && (
              <button type="button" className="disable-link" onClick={() => void onTrust(agent.id, "disabled")}>Disable ACP</button>
            )}
          </article>
        ))}
        {agents.length === 0 && <div className="empty-state">No supported local agents have been detected yet.</div>}
      </div>
    </aside>
  );
}
