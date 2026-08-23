import type { AgentAdapter, AgentResponse, RegisteredAgent } from "../../protocol/src/index.js";

export interface AgentCapabilityScore {
  agentId: string;
  capability: string;
  successRate: number;
  qualityScore: number;
  latencyScore: number;
  costScore?: number;
  sampleCount: number;
  confidence: number;
}

export interface RoutingCandidate {
  agent: RegisteredAgent;
  capabilityScore?: AgentCapabilityScore;
  available: boolean;
  trust: number;
  memoryRelevance: number;
  workspaceLocality: number;
  federationLatencyScore: number;
  permissionFit: number;
}

export class ExpertRouter {
  rank(capability: string, candidates: RoutingCandidate[]): RoutingCandidate[] {
    return candidates
      .filter((candidate) => candidate.available && candidate.agent.capabilities.includes(capability))
      .map((candidate) => ({ candidate, score: this.score(candidate) }))
      .sort((a, b) => b.score - a.score)
      .map(({ candidate }) => candidate);
  }

  private score(candidate: RoutingCandidate): number {
    const evidence = candidate.capabilityScore;
    const evidenceScore = evidence
      ? (evidence.successRate * 0.3 + evidence.qualityScore * 0.3 + evidence.latencyScore * 0.1 + (evidence.costScore ?? 0.5) * 0.05) * evidence.confidence
      : 0.15;
    const sampleConfidence = evidence ? Math.min(1, Math.log10(evidence.sampleCount + 1) / 2) : 0.1;
    return evidenceScore * 0.55 + candidate.trust * 0.15 + candidate.memoryRelevance * 0.1 + candidate.workspaceLocality * 0.07 + candidate.federationLatencyScore * 0.05 + candidate.permissionFit * 0.08 + sampleConfidence * 0.05;
  }
}

export interface CollectiveGatewayRegistry {
  list(capability?: string): RegisteredAgent[];
  get(id: string): RegisteredAgent;
  adapterFor(agentId: string): AgentAdapter;
}

export interface CollectiveAgentSummary {
  id: string;
  name: string;
  canonicalUri: string;
  adapterType: string;
  status: RegisteredAgent["status"];
  capabilities: string[];
  metadata: Record<string, string | number | boolean | null>;
}

export interface FindAgentInput {
  query?: string;
  capability?: string;
}

export interface AskAgentInput {
  agentId: string;
  prompt: string;
  conversationId?: string;
  taskId?: string;
  workspaceId?: string;
}

export interface AskAgentResult extends AgentResponse {
  agentId: string;
  conversationId: string;
}

export interface CollectiveToolGateway {
  listAgents(input?: { capability?: string }): CollectiveAgentSummary[];
  findAgent(input: FindAgentInput): CollectiveAgentSummary[];
  askAgent(input: AskAgentInput): Promise<AskAgentResult>;
}

export interface CreateCollectiveToolGatewayOptions {
  registry: CollectiveGatewayRegistry;
  id?: (prefix: string) => string;
}

export function createCollectiveToolGateway(options: CreateCollectiveToolGatewayOptions): CollectiveToolGateway {
  let localCounter = 0;
  const id = options.id ?? ((prefix: string) => `${prefix}-${++localCounter}`);

  const listAgents = (input: { capability?: string } = {}): CollectiveAgentSummary[] =>
    options.registry.list(input.capability).map(toAgentSummary);

  const findAgent = (input: FindAgentInput): CollectiveAgentSummary[] => {
    const query = input.query?.trim().toLowerCase();
    return options.registry.list(input.capability)
      .filter((agent) => {
        if (!query) return true;
        const haystack = [agent.id, agent.name, agent.adapterType, agent.canonicalUri, ...agent.capabilities].join(" ").toLowerCase();
        return haystack.includes(query);
      })
      .map(toAgentSummary);
  };

  const askAgent = async (input: AskAgentInput): Promise<AskAgentResult> => {
    if (!input.prompt.trim()) throw new Error("Agent prompt must not be empty");
    const agent = options.registry.get(input.agentId);
    const adapter = options.registry.adapterFor(input.agentId);
    const conversationId = input.conversationId ?? id("conversation");
    const session = await adapter.createSession(agent, {
      conversationId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    });

    try {
      const response = await adapter.send(
        session,
        { intent: "ask", content: [{ type: "text", text: input.prompt }], artifacts: [] },
        {
          conversationId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        },
      );
      return { agentId: agent.id, conversationId, ...response };
    } finally {
      await adapter.terminateSession?.(session.id);
    }
  };

  return { listAgents, findAgent, askAgent };
}

const PUBLIC_AGENT_METADATA_KEYS = [
  "source",
  "version",
  "authStatus",
  "executablePath",
  "supportsStreaming",
  "supportsSessions",
  "supportsCancellation",
  "supportsTools",
  "supportsMcp",
] as const;

function toAgentSummary(agent: RegisteredAgent): CollectiveAgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    canonicalUri: agent.canonicalUri,
    adapterType: agent.adapterType,
    status: agent.status,
    capabilities: [...agent.capabilities],
    metadata: publicAgentMetadata(agent.metadata),
  };
}

function publicAgentMetadata(metadata: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of PUBLIC_AGENT_METADATA_KEYS) {
    const value = metadata[key];
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}
