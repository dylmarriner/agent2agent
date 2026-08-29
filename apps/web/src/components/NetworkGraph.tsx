import { useMemo } from "react";
import type { AgentDto, ConversationDto, MessageDto } from "../api.js";

export interface NetworkGraphProps {
  conversation?: ConversationDto;
  agents: AgentDto[];
  messages: MessageDto[];
}

interface NodePoint {
  id: string;
  label: string;
  x: number;
  y: number;
  human: boolean;
}

export function NetworkGraph({ conversation, agents, messages }: NetworkGraphProps) {
  const graph = useMemo(() => {
    if (!conversation) return { nodes: [] as NodePoint[], edges: [] as Array<{ key: string; from: NodePoint; to: NodePoint; count: number }> };
    const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
    const ids = [...new Set([
      ...conversation.participantIds,
      ...messages.flatMap((message) => [message.senderAgentId, ...message.recipientAgentIds]),
    ])];
    const centerX = 160;
    const centerY = 150;
    const radius = Math.min(110, 55 + ids.length * 8);
    const nodes = ids.map((id, index): NodePoint => {
      const angle = -Math.PI / 2 + (index / Math.max(ids.length, 1)) * Math.PI * 2;
      return {
        id,
        label: id.startsWith("human:") ? "You" : agentNames.get(id) ?? id,
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
        human: id.startsWith("human:"),
      };
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const counts = new Map<string, number>();
    for (const message of messages) {
      for (const recipientId of message.recipientAgentIds) {
        const key = `${message.senderAgentId}\u0000${recipientId}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const edges = [...counts].flatMap(([key, count]) => {
      const [fromId, toId] = key.split("\u0000");
      const from = fromId ? byId.get(fromId) : undefined;
      const to = toId ? byId.get(toId) : undefined;
      return from && to ? [{ key, from, to, count }] : [];
    });
    return { nodes, edges };
  }, [agents, conversation, messages]);

  return (
    <section className="network panel">
      <div className="panel-heading">
        <div>
          <h2>Conversation graph</h2>
          <p>Edges are derived from canonical message recipients.</p>
        </div>
      </div>
      {!conversation ? (
        <div className="empty-state">Select a conversation to see communication paths.</div>
      ) : (
        <svg viewBox="0 0 320 300" role="img" aria-label="Agent conversation network">
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L7,3 z" className="graph-arrow" />
            </marker>
          </defs>
          {graph.edges.map((edge) => (
            <g key={edge.key}>
              <line
                x1={edge.from.x}
                y1={edge.from.y}
                x2={edge.to.x}
                y2={edge.to.y}
                className="graph-edge"
                markerEnd="url(#arrow)"
              />
              {edge.count > 1 && (
                <text x={(edge.from.x + edge.to.x) / 2} y={(edge.from.y + edge.to.y) / 2 - 4} className="edge-count">{edge.count}</text>
              )}
            </g>
          ))}
          {graph.nodes.map((node) => (
            <g key={node.id} transform={`translate(${node.x}, ${node.y})`}>
              <circle r="20" className={node.human ? "graph-node graph-human" : "graph-node"} />
              <text y="4" textAnchor="middle" className="node-initial">{node.label.slice(0, 1).toUpperCase()}</text>
              <text y="34" textAnchor="middle" className="node-label">{shortLabel(node.label)}</text>
            </g>
          ))}
        </svg>
      )}
    </section>
  );
}

function shortLabel(value: string): string {
  return value.length > 18 ? `${value.slice(0, 16)}…` : value;
}
