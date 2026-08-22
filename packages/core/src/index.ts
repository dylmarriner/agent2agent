import type {
  AgentAdapter,
  AgentMessage,
  AgentPermissionPolicy,
  CollectiveEvent,
  CollectiveEventType,
  EvaluationResult,
  FederationEnvelope,
  KnowledgeItem,
  MemoryFeedback,
  MemoryQuery,
  MemoryRecallResult,
  MemoryRecord,
  RegisteredAgent,
  SpawnAgentRequest,
  SwarmLimits,
  TaskRecord,
  TemporalEdge,
} from "../../protocol/src/index.js";

export type { AgentAdapter } from "../../protocol/src/index.js";
export * from "../../protocol/src/index.js";

export class CollectiveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CollectiveError";
  }
}

export type IdFactory = (prefix: string) => string;

export function createMonotonicIdFactory(node = "local"): IdFactory {
  let counter = 0;
  return (prefix) => `${prefix}_${node}_${Date.now().toString(36)}_${(++counter).toString(36)}`;
}

export class EventStore {
  private readonly events: CollectiveEvent[] = [];
  private readonly subscribers = new Set<(event: CollectiveEvent) => void>();

  constructor(private readonly nodeId: string, private readonly id: IdFactory) {}

  publish<T>(type: CollectiveEventType, data: T, refs: Partial<Pick<CollectiveEvent, "conversationId" | "taskId" | "agentId">> = {}): CollectiveEvent<T> {
    const event: CollectiveEvent<T> = {
      id: this.id("evt"),
      type,
      nodeId: this.nodeId,
      at: new Date().toISOString(),
      data,
      ...refs,
    };
    this.events.push(event);
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }

  list(type?: CollectiveEventType): CollectiveEvent[] {
    return this.events.filter((event) => type === undefined || event.type === type).map((event) => ({ ...event }));
  }

  subscribe(listener: (event: CollectiveEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
}

export class AgentRegistry {
  private readonly agents = new Map<string, RegisteredAgent>();
  private readonly adapters = new Map<string, AgentAdapter>();

  constructor(private readonly events: EventStore) {}

  registerAdapter(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.type)) throw new CollectiveError("adapter_exists", `Adapter ${adapter.type} already registered`);
    this.adapters.set(adapter.type, adapter);
  }

  register(agent: RegisteredAgent): RegisteredAgent {
    if (this.agents.has(agent.id)) throw new CollectiveError("agent_exists", `Agent ${agent.id} already registered`);
    if (!this.adapters.has(agent.adapterType)) throw new CollectiveError("adapter_missing", `No adapter registered for ${agent.adapterType}`);
    this.agents.set(agent.id, { ...agent, capabilities: [...agent.capabilities], metadata: { ...agent.metadata } });
    this.events.publish("agent.connected", { agentId: agent.id, adapterType: agent.adapterType }, { agentId: agent.id });
    return this.get(agent.id);
  }

  get(id: string): RegisteredAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new CollectiveError("agent_not_found", `Unknown agent ${id}`);
    return { ...agent, capabilities: [...agent.capabilities], metadata: { ...agent.metadata } };
  }

  list(capability?: string): RegisteredAgent[] {
    return [...this.agents.values()]
      .filter((agent) => capability === undefined || agent.capabilities.includes(capability))
      .map((agent) => ({ ...agent, capabilities: [...agent.capabilities], metadata: { ...agent.metadata } }));
  }

  adapterFor(agentId: string): AgentAdapter {
    const agent = this.get(agentId);
    const adapter = this.adapters.get(agent.adapterType);
    if (!adapter) throw new CollectiveError("adapter_missing", `Adapter ${agent.adapterType} unavailable`);
    return adapter;
  }

  remove(id: string): void {
    if (this.agents.delete(id)) this.events.publish("agent.disconnected", { agentId: id }, { agentId: id });
  }
}

export class TaskDag {
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(private readonly events: EventStore) {}

  add(task: TaskRecord): void {
    if (this.tasks.has(task.id)) throw new CollectiveError("task_exists", `Task ${task.id} already exists`);
    for (const dependency of task.dependencyIds) {
      if (!this.tasks.has(dependency)) throw new CollectiveError("dependency_missing", `Task ${task.id} depends on unknown task ${dependency}`);
    }
    this.tasks.set(task.id, structuredClone(task));
    try {
      this.assertAcyclic();
    } catch (error) {
      this.tasks.delete(task.id);
      throw error;
    }
    this.events.publish("task.created", { taskId: task.id, dependencies: task.dependencyIds }, { taskId: task.id, conversationId: task.conversationId });
  }

  get(id: string): TaskRecord {
    const task = this.tasks.get(id);
    if (!task) throw new CollectiveError("task_not_found", `Unknown task ${id}`);
    return structuredClone(task);
  }

  ready(): TaskRecord[] {
    return [...this.tasks.values()].filter((task) => task.status === "pending" && task.dependencyIds.every((id) => this.tasks.get(id)?.status === "completed")).map((value) => structuredClone(value));
  }

  transition(id: string, status: TaskRecord["status"]): TaskRecord {
    const task = this.tasks.get(id);
    if (!task) throw new CollectiveError("task_not_found", `Unknown task ${id}`);
    if (task.status === "completed" || task.status === "cancelled") throw new CollectiveError("task_terminal", `Task ${id} is already terminal`);
    task.status = status;
    task.updatedAt = new Date().toISOString();
    if (status === "completed") this.events.publish("task.completed", { taskId: id }, { taskId: id, conversationId: task.conversationId });
    return structuredClone(task);
  }

  list(): TaskRecord[] { return [...this.tasks.values()].map((value) => structuredClone(value)); }

  private assertAcyclic(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new CollectiveError("task_cycle", `Task cycle detected at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of this.tasks.get(id)?.dependencyIds ?? []) visit(dep);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of this.tasks.keys()) visit(id);
  }
}

interface SpawnedAgentState {
  id: string;
  parentAgentId: string;
  parentTaskId: string;
  conversationId: string;
  depth: number;
  request: SpawnAgentRequest;
  startedAt: number;
  messages: number;
  cost: number;
  status: "active" | "completed" | "terminated";
  result?: unknown;
}

export class SwarmRuntime {
  private readonly subagents = new Map<string, SpawnedAgentState>();

  constructor(private readonly registry: AgentRegistry, private readonly events: EventStore, private readonly limits: SwarmLimits, private readonly id: IdFactory) {}

  spawn(request: SpawnAgentRequest, conversationId: string): RegisteredAgent {
    const parent = this.registry.get(request.parentAgentId);
    if (!request.permissionPolicy.swarm.spawn) throw new CollectiveError("spawn_denied", "Parent policy forbids spawning specialists");
    const parentState = this.subagents.get(parent.id);
    const depth = parentState ? parentState.depth + 1 : 1;
    if (depth > this.limits.maxDepth) throw new CollectiveError("swarm_depth", `Swarm depth ${depth} exceeds ${this.limits.maxDepth}`);
    const active = [...this.subagents.values()].filter((agent) => agent.status === "active");
    if (active.length >= this.limits.maxActiveSubagents) throw new CollectiveError("swarm_active_limit", "Active subagent limit reached");
    if (active.filter((agent) => agent.conversationId === conversationId).length >= this.limits.maxSubagentsPerConversation) throw new CollectiveError("swarm_conversation_limit", "Conversation subagent limit reached");
    const children = active.filter((agent) => agent.parentAgentId === request.parentAgentId).length;
    const parentChildLimit = parentState
      ? Math.min(this.limits.maxChildrenPerAgent, parentState.request.maxChildren, parentState.request.permissionPolicy.swarm.maxChildren)
      : this.limits.maxChildrenPerAgent;
    if (children >= parentChildLimit) throw new CollectiveError("swarm_children_limit", "Child subagent limit reached");
    const maxRuntimeSeconds = Math.min(request.maxRuntimeSeconds, this.limits.maxRuntimeSeconds);
    if (maxRuntimeSeconds <= 0) throw new CollectiveError("swarm_runtime_limit", "Subagent runtime must be positive");

    const agentId = this.id("subagent");
    const agent: RegisteredAgent = {
      id: agentId,
      nodeId: parent.nodeId,
      canonicalUri: `a2a://${parent.nodeId}/agents/${agentId}`,
      name: request.specialization,
      adapterType: parent.adapterType,
      capabilities: request.requiredCapabilities ?? parent.capabilities,
      status: "idle",
      ephemeral: true,
      parentAgentId: parent.id,
      metadata: { specialization: request.specialization, objective: request.objective },
    };
    this.registry.register(agent);
    this.subagents.set(agentId, { id: agentId, parentAgentId: parent.id, parentTaskId: request.parentTaskId, conversationId, depth, request: { ...request, maxRuntimeSeconds }, startedAt: Date.now(), messages: 0, cost: 0, status: "active" });
    this.events.publish("subagent.spawned", { subagentId: agentId, parentAgentId: parent.id, depth }, { agentId, taskId: request.parentTaskId, conversationId });
    return agent;
  }

  recordUsage(id: string, messages: number, cost = 0): void {
    const state = this.requireState(id);
    state.messages += messages;
    state.cost += cost;
    const elapsed = (Date.now() - state.startedAt) / 1000;
    if (state.messages > Math.min(state.request.maxMessages, this.limits.maxMessagesPerSubagent)) this.terminate(id, "message_limit");
    else if (elapsed > state.request.maxRuntimeSeconds) this.terminate(id, "runtime_limit");
    else if (state.request.maxCost !== undefined && state.cost > state.request.maxCost) this.terminate(id, "cost_limit");
  }

  complete(id: string, result: unknown): unknown {
    const state = this.requireState(id);
    state.status = "completed";
    state.result = result;
    this.events.publish("subagent.completed", { subagentId: id, result }, { agentId: id, taskId: state.parentTaskId, conversationId: state.conversationId });
    this.registry.remove(id);
    return result;
  }

  terminate(id: string, reason: string): void {
    const state = this.requireState(id);
    if (state.status !== "active") return;
    state.status = "terminated";
    this.events.publish("subagent.terminated", { subagentId: id, reason }, { agentId: id, taskId: state.parentTaskId, conversationId: state.conversationId });
    this.registry.remove(id);
  }

  list(): SpawnedAgentState[] { return [...this.subagents.values()].map((value) => structuredClone(value)); }

  private requireState(id: string): SpawnedAgentState {
    const state = this.subagents.get(id);
    if (!state) throw new CollectiveError("subagent_not_found", `Unknown subagent ${id}`);
    return state;
  }
}

export class InMemoryMemoryProvider {
  readonly name = "postgres-fallback";
  private readonly records = new Map<string, MemoryRecord>();

  constructor(private readonly id: IdFactory) {}

  async ingest(input: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">): Promise<MemoryRecord> {
    const now = new Date().toISOString();
    const record: MemoryRecord = { ...structuredClone(input), id: this.id("mem"), createdAt: now, updatedAt: now };
    this.records.set(record.id, record);
    return structuredClone(record);
  }

  async recall(query: MemoryQuery): Promise<MemoryRecallResult[]> {
    const terms = new Set(query.text.toLowerCase().split(/\W+/).filter(Boolean));
    const allowed = new Set(query.allowedScopes.map(({ scope, scopeId }) => `${scope}:${scopeId}`));
    return [...this.records.values()]
      .filter((record) => allowed.has(`${record.scope}:${record.scopeId}`) && record.validation !== "rejected")
      .map((record) => {
        const words = new Set(record.content.toLowerCase().split(/\W+/).filter(Boolean));
        const overlap = [...terms].filter((term) => words.has(term)).length / Math.max(1, terms.size);
        const score = overlap * 0.55 + record.confidence * 0.2 + record.salience * 0.15 + record.usefulness * 0.1;
        return { record: structuredClone(record), score, provider: this.name, reasons: [`lexical=${overlap.toFixed(3)}`, `confidence=${record.confidence.toFixed(3)}`, `salience=${record.salience.toFixed(3)}`] };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit ?? 10);
  }

  async reinforce(input: MemoryFeedback): Promise<void> {
    const record = this.records.get(input.memoryId);
    if (!record) throw new CollectiveError("memory_not_found", `Unknown memory ${input.memoryId}`);
    record.usefulness = clamp(record.usefulness + (input.useful ? 0.05 : -0.05));
    record.salience = clamp(record.salience + (input.useful ? 0.03 : -0.02));
    if (input.evidenceId && !record.evidenceIds.includes(input.evidenceId)) record.evidenceIds.push(input.evidenceId);
    record.updatedAt = new Date().toISOString();
  }

  async supersede(previousId: string, replacementId: string): Promise<void> {
    if (!this.records.has(replacementId)) throw new CollectiveError("memory_not_found", `Unknown replacement memory ${replacementId}`);
    const previous = this.records.get(previousId);
    if (!previous) throw new CollectiveError("memory_not_found", `Unknown previous memory ${previousId}`);
    previous.validation = "superseded";
    previous.salience = clamp(previous.salience * 0.3);
    previous.updatedAt = new Date().toISOString();
  }
}

export interface OptionalMemoryProvider {
  name: string;
  available(): Promise<boolean>;
  recall(query: MemoryQuery): Promise<MemoryRecallResult[]>;
}

export class HybridMemory {
  constructor(private readonly authoritative: InMemoryMemoryProvider, private readonly optional: OptionalMemoryProvider[] = []) {}

  ingest(input: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">): Promise<MemoryRecord> { return this.authoritative.ingest(input); }
  reinforce(input: MemoryFeedback): Promise<void> { return this.authoritative.reinforce(input); }

  async recall(query: MemoryQuery): Promise<MemoryRecallResult[]> {
    const groups = [await this.authoritative.recall(query)];
    for (const provider of this.optional) {
      try {
        if (await provider.available()) groups.push(await provider.recall(query));
      } catch {
        // Optional cognitive stores must never make authoritative recall unavailable.
      }
    }
    const byId = new Map<string, MemoryRecallResult>();
    for (const result of groups.flat()) {
      const existing = byId.get(result.record.id);
      if (!existing || result.score > existing.score) byId.set(result.record.id, result);
    }
    return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, query.limit ?? 10);
  }
}

export class TemporalKnowledgeGraph {
  private readonly nodes = new Set<string>();
  private readonly edges = new Map<string, TemporalEdge>();

  constructor(private readonly id: IdFactory) {}

  addNode(id: string): void { this.nodes.add(id); }

  link(input: Omit<TemporalEdge, "id" | "createdAt">): TemporalEdge {
    if (!this.nodes.has(input.sourceId) || !this.nodes.has(input.targetId)) throw new CollectiveError("graph_node_missing", "Both graph nodes must exist before linking");
    const edge: TemporalEdge = { ...structuredClone(input), id: this.id("edge"), createdAt: new Date().toISOString() };
    this.edges.set(edge.id, edge);
    return structuredClone(edge);
  }

  neighbors(id: string, at = new Date().toISOString()): TemporalEdge[] {
    return [...this.edges.values()].filter((edge) => (edge.sourceId === id || edge.targetId === id) && edge.validFrom <= at && (edge.validTo === undefined || edge.validTo > at)).map((value) => structuredClone(value));
  }

  close(edgeId: string, validTo = new Date().toISOString()): void {
    const edge = this.edges.get(edgeId);
    if (!edge) throw new CollectiveError("graph_edge_missing", `Unknown edge ${edgeId}`);
    edge.validTo = validTo;
  }
}

export class SharedIntelligence {
  private readonly items = new Map<string, KnowledgeItem>();

  constructor(private readonly events: EventStore, private readonly id: IdFactory) {}

  propose(input: Omit<KnowledgeItem, "id" | "validationStatus" | "createdAt" | "updatedAt">): KnowledgeItem {
    const now = new Date().toISOString();
    const item: KnowledgeItem = { ...structuredClone(input), id: this.id("knowledge"), validationStatus: "candidate", createdAt: now, updatedAt: now };
    this.items.set(item.id, item);
    this.events.publish("knowledge.proposed", { knowledgeId: item.id, title: item.title });
    return structuredClone(item);
  }

  validate(id: string, evidenceIds: string[]): KnowledgeItem {
    const item = this.require(id);
    if (evidenceIds.length === 0) throw new CollectiveError("knowledge_evidence_required", "Validation requires evidence");
    item.validationStatus = "validated";
    item.evidenceIds = [...new Set([...item.evidenceIds, ...evidenceIds])];
    item.updatedAt = new Date().toISOString();
    this.events.publish("knowledge.validated", { knowledgeId: id, evidenceIds });
    return structuredClone(item);
  }

  promote(id: string): KnowledgeItem {
    const item = this.require(id);
    if (item.validationStatus !== "validated") throw new CollectiveError("knowledge_not_validated", `Knowledge ${id} is not validated`);
    this.events.publish("knowledge.promoted", { knowledgeId: id });
    return structuredClone(item);
  }

  private require(id: string): KnowledgeItem {
    const item = this.items.get(id);
    if (!item) throw new CollectiveError("knowledge_not_found", `Unknown knowledge ${id}`);
    return item;
  }
}

export interface BenchmarkMeasurement { caseId: string; success: boolean; quality: number; latencyMs: number; cost?: number; }

export class EvaluationEngine {
  compare(candidateId: string, baselineId: string, benchmarkId: string, baseline: BenchmarkMeasurement[], candidate: BenchmarkMeasurement[]): EvaluationResult {
    const baselineById = new Map(baseline.map((measurement) => [measurement.caseId, measurement]));
    const candidateById = new Map(candidate.map((measurement) => [measurement.caseId, measurement]));
    const common = [...baselineById.keys()].filter((id) => candidateById.has(id));
    if (common.length === 0) throw new CollectiveError("benchmark_empty", "Candidate and baseline share no benchmark cases");
    const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const successDelta = avg(common.map((id) => Number(candidateById.get(id)!.success))) - avg(common.map((id) => Number(baselineById.get(id)!.success)));
    const qualityDelta = avg(common.map((id) => candidateById.get(id)!.quality - baselineById.get(id)!.quality));
    const latencyDelta = avg(common.map((id) => candidateById.get(id)!.latencyMs - baselineById.get(id)!.latencyMs));
    const hasCost = common.some((id) => candidateById.get(id)!.cost !== undefined || baselineById.get(id)!.cost !== undefined);
    const costDelta = hasCost ? avg(common.map((id) => (candidateById.get(id)!.cost ?? 0) - (baselineById.get(id)!.cost ?? 0))) : undefined;
    const regressions: EvaluationResult["regressions"] = [];
    for (const id of common) {
      const before = baselineById.get(id)!;
      const after = candidateById.get(id)!;
      if (before.success && !after.success) regressions.push({ caseId: id, description: "Previously passing case failed", severity: "high" });
      else if (after.quality < before.quality - 0.15) regressions.push({ caseId: id, description: "Quality regressed by more than 0.15", severity: "medium" });
    }
    const verdict: EvaluationResult["verdict"] = regressions.some((regression) => regression.severity === "high") || successDelta < 0 || qualityDelta < -0.02
      ? "reject"
      : successDelta > 0 || qualityDelta >= 0.03
        ? "promote"
        : "needs-review";
    return { candidateId, baselineId, benchmarkId, successDelta, qualityDelta, latencyDelta, ...(costDelta === undefined ? {} : { costDelta }), regressions, verdict };
  }
}

export class FederationGuard {
  private readonly nonces = new Set<string>();

  constructor(private readonly localNodeId: string) {}

  validate<T>(envelope: FederationEnvelope<T>): void {
    if (envelope.destinationNodeId !== this.localNodeId) throw new CollectiveError("federation_destination", "Envelope addressed to another node");
    if (envelope.hopCount > envelope.maxHops) throw new CollectiveError("federation_hop_limit", "Federation hop limit exceeded");
    if (envelope.visitedNodeIds.includes(this.localNodeId)) throw new CollectiveError("federation_loop", "Federation routing loop detected");
    if (this.nonces.has(envelope.nonce)) throw new CollectiveError("federation_replay", "Federation replay detected");
    const sentAt = Date.parse(envelope.sentAt);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 5 * 60_000) throw new CollectiveError("federation_stale", "Federation envelope outside anti-replay window");
    this.nonces.add(envelope.nonce);
  }

  forward<T>(envelope: FederationEnvelope<T>, destinationNodeId: string): FederationEnvelope<T> {
    if (envelope.hopCount + 1 > envelope.maxHops) throw new CollectiveError("federation_hop_limit", "Cannot forward beyond hop limit");
    if (envelope.visitedNodeIds.includes(destinationNodeId)) throw new CollectiveError("federation_loop", "Destination was already visited");
    return { ...structuredClone(envelope), destinationNodeId, hopCount: envelope.hopCount + 1, visitedNodeIds: [...envelope.visitedNodeIds, this.localNodeId] };
  }
}

export interface ConversationLimits {
  maxRounds: number;
  maxMessages: number;
  maxConsecutiveAgentTurns: number;
}

export class ConversationEngine {
  private readonly messages: AgentMessage[] = [];
  private readonly consecutiveTurns = new Map<string, number>();

  constructor(private readonly registry: AgentRegistry, private readonly events: EventStore, private readonly limits: ConversationLimits) {}

  async route(message: AgentMessage): Promise<void> {
    if (message.round > this.limits.maxRounds) throw new CollectiveError("conversation_round_limit", "Conversation round limit exceeded");
    if (this.messages.filter((entry) => entry.conversationId === message.conversationId).length >= this.limits.maxMessages) throw new CollectiveError("conversation_message_limit", "Conversation message limit exceeded");
    if (this.messages.some((entry) => entry.conversationId === message.conversationId && entry.senderAgentId === message.senderAgentId && JSON.stringify(entry.content) === JSON.stringify(message.content))) throw new CollectiveError("duplicate_message", "Duplicate message detected");
    const current = (this.consecutiveTurns.get(message.senderAgentId) ?? 0) + 1;
    if (current > this.limits.maxConsecutiveAgentTurns) throw new CollectiveError("consecutive_turn_limit", "Consecutive agent turn limit exceeded");
    for (const agent of this.registry.list()) this.consecutiveTurns.set(agent.id, agent.id === message.senderAgentId ? current : 0);
    this.messages.push(structuredClone(message));
    this.events.publish("message.created", { messageId: message.id, intent: message.intent }, { conversationId: message.conversationId, agentId: message.senderAgentId, ...(message.taskId ? { taskId: message.taskId } : {}) });
    for (const recipientId of message.recipientAgentIds) {
      const recipient = this.registry.get(recipientId);
      const adapter = this.registry.adapterFor(recipientId);
      const session = await adapter.createSession(recipient, { conversationId: message.conversationId, ...(message.taskId ? { taskId: message.taskId } : {}) });
      await adapter.send(session, { intent: message.intent, content: message.content, artifacts: message.artifacts }, { conversationId: message.conversationId, ...(message.taskId ? { taskId: message.taskId } : {}) });
      this.events.publish("message.delivered", { messageId: message.id, recipientId }, { conversationId: message.conversationId, agentId: recipientId, ...(message.taskId ? { taskId: message.taskId } : {}) });
    }
  }

  history(conversationId: string): AgentMessage[] { return this.messages.filter((message) => message.conversationId === conversationId).map((value) => structuredClone(value)); }
}

export function defaultPermissionPolicy(): AgentPermissionPolicy {
  return {
    filesystem: { mode: "workspace" },
    git: { createBranches: true, mergeToProtected: false },
    shell: { allowed: true },
    network: { allowedHosts: [] },
    memory: { readScopes: ["task", "conversation", "project", "shared"], propose: true, publish: false },
    swarm: { spawn: true, maxChildren: 4 },
    federation: { sendTasks: true, receiveTasks: false },
  };
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
