export type CollaborationIntent =
  | "ask" | "delegate" | "research" | "review" | "critique" | "verify"
  | "test" | "debug" | "improve" | "compare" | "challenge" | "teach"
  | "summarize" | "vote" | "synthesize" | "spawn-specialist" | "merge-findings"
  | "request-memory" | "publish-knowledge" | "request-skill";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown }
  | { type: "reference"; uri: string; mediaType?: string };

export interface ArtifactReference {
  id: string;
  kind: "file" | "diff" | "test-report" | "trace" | "link" | "other";
  uri: string;
  checksum?: string;
}

export interface RoutingMetadata {
  originNodeId: string;
  currentNodeId: string;
  hopCount: number;
  visitedNodeIds: string[];
  adapterType?: string;
  vendorMessageId?: string;
}

export interface AgentMessage {
  id: string;
  conversationId: string;
  senderAgentId: string;
  recipientAgentIds: string[];
  intent: CollaborationIntent;
  taskId?: string;
  parentMessageId?: string;
  correlationId: string;
  round: number;
  sequence: number;
  content: MessagePart[];
  artifacts: ArtifactReference[];
  routingMetadata: RoutingMetadata;
  createdAt: string;
}

export type AgentStatus = "offline" | "idle" | "busy" | "degraded" | "disabled";

export interface RegisteredAgent {
  id: string;
  nodeId: string;
  canonicalUri: string;
  name: string;
  adapterType: string;
  capabilities: string[];
  status: AgentStatus;
  ephemeral: boolean;
  parentAgentId?: string;
  metadata: Record<string, unknown>;
}

export interface AgentCapabilities {
  capabilities: string[];
  supportsStreaming: boolean;
  supportsSessions: boolean;
  supportsCancellation: boolean;
  supportsTools: boolean;
}

export interface AgentHealth {
  ok: boolean;
  message?: string;
  checkedAt: string;
}

export interface AgentSessionOptions {
  conversationId: string;
  workspaceId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentSession {
  id: string;
  agentId: string;
  vendorSessionId?: string;
  createdAt: string;
}

export interface AgentRequest {
  intent: CollaborationIntent;
  content: MessagePart[];
  artifacts?: ArtifactReference[];
}

export interface AgentContext {
  conversationId: string;
  taskId?: string;
  workspaceId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface AgentResponse {
  content: MessagePart[];
  artifacts: ArtifactReference[];
  usage?: { inputTokens?: number; outputTokens?: number; cost?: number };
  vendorMessageId?: string;
}

export interface AgentEvent {
  type: "delta" | "tool-call" | "tool-result" | "artifact" | "status" | "error";
  data: unknown;
  at: string;
}

export interface AgentAdapter {
  readonly type: string;
  discover(config: Record<string, unknown>): Promise<AgentCapabilities>;
  healthCheck(agent: RegisteredAgent): Promise<AgentHealth>;
  createSession(agent: RegisteredAgent, options: AgentSessionOptions): Promise<AgentSession>;
  send(session: AgentSession, request: AgentRequest, context: AgentContext): Promise<AgentResponse>;
  stream?(session: AgentSession, request: AgentRequest, context: AgentContext): AsyncIterable<AgentEvent>;
  cancel?(executionId: string): Promise<void>;
  terminateSession?(sessionId: string): Promise<void>;
}

export type TaskStatus = "pending" | "ready" | "running" | "blocked" | "review" | "completed" | "failed" | "cancelled";

export interface TaskRecord {
  id: string;
  conversationId: string;
  title: string;
  objective: string;
  status: TaskStatus;
  ownerAgentId?: string;
  reviewerAgentIds: string[];
  dependencyIds: string[];
  parentTaskId?: string;
  workspaceId?: string;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPermissionPolicy {
  filesystem: { mode: "none" | "read" | "workspace" };
  git: { createBranches: boolean; mergeToProtected: boolean };
  shell: { allowed: boolean; allowedCommands?: string[] };
  network: { allowedHosts: string[] };
  memory: { readScopes: MemoryScope[]; propose: boolean; publish: boolean };
  swarm: { spawn: boolean; maxChildren: number };
  federation: { sendTasks: boolean; receiveTasks: boolean };
}

export type WorkspacePolicy = "none" | "shared-read" | "isolated-worktree";

export interface SpawnAgentRequest {
  parentAgentId: string;
  parentTaskId: string;
  specialization: string;
  objective: string;
  requiredCapabilities?: string[];
  maxRuntimeSeconds: number;
  maxMessages: number;
  maxCost?: number;
  maxChildren: number;
  workspacePolicy: WorkspacePolicy;
  permissionPolicy: AgentPermissionPolicy;
}

export interface SwarmLimits {
  maxDepth: number;
  maxChildrenPerAgent: number;
  maxActiveSubagents: number;
  maxSubagentsPerConversation: number;
  maxRuntimeSeconds: number;
  maxMessagesPerSubagent: number;
  maxCostPerSubagent?: number;
}

export type MemoryScope = "turn" | "task" | "conversation" | "agent" | "workspace" | "project" | "organization" | "shared";

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  content: string;
  confidence: number;
  salience: number;
  usefulness: number;
  validation: "candidate" | "validated" | "rejected" | "superseded";
  evidenceIds: string[];
  sourceAgentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryQuery {
  text: string;
  allowedScopes: Array<{ scope: MemoryScope; scopeId: string }>;
  limit?: number;
}

export interface MemoryRecallResult {
  record: MemoryRecord;
  score: number;
  provider: string;
  reasons: string[];
}

export interface MemoryFeedback {
  memoryId: string;
  useful: boolean;
  taskSucceeded?: boolean;
  evidenceId?: string;
}

export interface CognitiveMemoryProvider {
  readonly name: string;
  ingest(input: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">): Promise<MemoryRecord>;
  recall(query: MemoryQuery): Promise<MemoryRecallResult[]>;
  reinforce?(input: MemoryFeedback): Promise<void>;
  supersede?(previousId: string, replacementId: string): Promise<void>;
  forget?(memoryId: string): Promise<void>;
  explainRecall?(resultId: string): Promise<Record<string, unknown>>;
}

export interface TemporalEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  validFrom: string;
  validTo?: string;
  confidence?: number;
  sourceConversationId?: string;
  sourceTaskId?: string;
  evidenceIds: string[];
  createdAt: string;
}

export interface KnowledgeItem {
  id: string;
  type: "fact" | "insight" | "strategy" | "pattern" | "solution" | "failure" | "warning" | "skill" | "procedure";
  title: string;
  content: string;
  sourceAgentIds: string[];
  sourceConversationIds: string[];
  evidenceIds: string[];
  confidence: number;
  usefulnessScore: number;
  validationStatus: "candidate" | "validated" | "rejected" | "superseded";
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationResult {
  candidateId: string;
  baselineId: string;
  benchmarkId: string;
  successDelta: number;
  qualityDelta: number;
  latencyDelta: number;
  costDelta?: number;
  regressions: Array<{ caseId: string; description: string; severity: "low" | "medium" | "high" }>;
  verdict: "promote" | "reject" | "needs-review";
}

export interface FederatedAgentIdentity {
  nodeId: string;
  agentId: string;
  canonicalUri: string;
}

export interface FederationEnvelope<T = unknown> {
  id: string;
  originNodeId: string;
  destinationNodeId: string;
  visitedNodeIds: string[];
  hopCount: number;
  maxHops: number;
  correlationId: string;
  conversationId?: string;
  taskId?: string;
  nonce: string;
  sentAt: string;
  payload: T;
}

export type CollectiveEventType =
  | "conversation.created" | "conversation.started" | "conversation.paused" | "conversation.completed"
  | "agent.connected" | "agent.disconnected"
  | "subagent.spawned" | "subagent.completed" | "subagent.terminated"
  | "task.created" | "task.delegated" | "task.completed"
  | "message.created" | "message.routed" | "message.delivered"
  | "workspace.created" | "workspace.changed" | "workspace.review_requested" | "workspace.conflict_detected" | "workspace.merged"
  | "memory.recalled" | "memory.reinforced"
  | "knowledge.proposed" | "knowledge.validated" | "knowledge.promoted"
  | "benchmark.started" | "benchmark.completed" | "candidate.promoted" | "candidate.rejected"
  | "package.installed" | "package.updated"
  | "federation.peer_connected" | "federation.task_sent" | "federation.task_received" | "federation.failed";

export interface CollectiveEvent<T = unknown> {
  id: string;
  type: CollectiveEventType;
  nodeId: string;
  conversationId?: string;
  taskId?: string;
  agentId?: string;
  at: string;
  data: T;
}
