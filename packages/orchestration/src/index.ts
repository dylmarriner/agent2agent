import type { RegisteredAgent } from "../../protocol/src/index.js";

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
