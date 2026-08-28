export type TrustStatus = "trusted" | "pending-trust" | "disabled";

export interface AgentDto {
  id: string;
  name: string;
  canonicalUri: string;
  adapterType: string;
  status: "offline" | "idle" | "busy" | "degraded" | "disabled";
  capabilities: string[];
  transportTypes: string[];
  trustStatus: TrustStatus;
  version?: string;
  authStatus?: string;
  supportsAcp: boolean;
  supportsMcp: boolean;
  supportsStreaming: boolean;
  supportsSessions: boolean;
  supportsCancellation: boolean;
  supportsTools: boolean;
}

export interface ConversationDto {
  id: string;
  nodeId: string;
  title: string;
  objective: string;
  status: "created" | "active" | "paused" | "completed" | "failed";
  participantIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MessagePartDto {
  type: "text" | "json" | "reference";
  text?: string;
  value?: unknown;
  uri?: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderAgentId: string;
  recipientAgentIds: string[];
  intent: string;
  parentMessageId?: string;
  correlationId: string;
  round: number;
  sequence: number;
  content: MessagePartDto[];
  artifacts: Array<{ id: string; kind: string; uri: string }>;
  createdAt: string;
}

export interface EventDto {
  id: string;
  type: string;
  nodeId: string;
  conversationId?: string;
  taskId?: string;
  agentId?: string;
  at: string;
  data: unknown;
}

export interface HealthDto {
  ok: boolean;
  nodeId: string;
  startedAt: string;
  uptimeMs: number;
  agents: number;
  conversations: number;
  events: number;
}

const eventTypes = [
  "conversation.created", "conversation.started", "conversation.paused", "conversation.completed",
  "agent.connected", "agent.disconnected", "subagent.spawned", "subagent.completed", "subagent.terminated",
  "task.created", "task.delegated", "task.completed", "message.created", "message.routed", "message.delivered",
  "workspace.created", "workspace.changed", "workspace.review_requested", "workspace.conflict_detected", "workspace.merged",
  "memory.recalled", "memory.reinforced", "knowledge.proposed", "knowledge.validated", "knowledge.promoted",
  "benchmark.started", "benchmark.completed", "candidate.promoted", "candidate.rejected", "package.installed", "package.updated",
  "federation.peer_connected", "federation.task_sent", "federation.task_received", "federation.failed",
] as const;

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { error?: { message?: string } };
      detail = body.error?.message ?? detail;
    } catch {
      // Preserve the HTTP status when the response is not JSON.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function fetchHealth(): Promise<HealthDto> {
  return requestJson<HealthDto>("/api/v1/system/health");
}

export async function fetchAgents(): Promise<AgentDto[]> {
  const body = await requestJson<{ agents: AgentDto[] }>("/api/v1/agents");
  return body.agents;
}

export async function updateTrust(agentId: string, trustStatus: TrustStatus): Promise<AgentDto> {
  const body = await requestJson<{ agent: AgentDto }>(`/api/v1/agents/${encodeURIComponent(agentId)}/trust`, {
    method: "POST",
    body: JSON.stringify({ trustStatus }),
  });
  return body.agent;
}

export async function fetchConversations(): Promise<ConversationDto[]> {
  const body = await requestJson<{ conversations: ConversationDto[] }>("/api/v1/conversations");
  return body.conversations;
}

export async function createConversation(input: { title: string; objective: string; participantIds: string[] }): Promise<ConversationDto> {
  const body = await requestJson<{ conversation: ConversationDto }>("/api/v1/conversations", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.conversation;
}

export async function fetchMessages(conversationId: string): Promise<MessageDto[]> {
  const body = await requestJson<{ messages: MessageDto[] }>(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`);
  return body.messages;
}

export async function sendMessage(conversationId: string, text: string, intent = "ask"): Promise<{ message: MessageDto; produced: MessageDto[] }> {
  return requestJson(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, intent }),
  });
}

export async function fetchEvents(after?: string): Promise<EventDto[]> {
  const query = after ? `?after=${encodeURIComponent(after)}` : "";
  const body = await requestJson<{ events: EventDto[] }>(`/api/v1/events${query}`);
  return body.events;
}

export function subscribeEvents(onEvent: (event: EventDto) => void, onConnection: (connected: boolean) => void): () => void {
  const source = new EventSource("/api/v1/events/stream");
  const listeners = new Map<string, EventListener>();
  const handle = (raw: Event): void => {
    const event = raw as MessageEvent<string>;
    try {
      onEvent(JSON.parse(event.data) as EventDto);
    } catch {
      // Ignore malformed events. The next canonical event will still arrive.
    }
  };
  for (const type of eventTypes) {
    const listener: EventListener = handle;
    listeners.set(type, listener);
    source.addEventListener(type, listener);
  }
  source.onopen = () => onConnection(true);
  source.onerror = () => onConnection(false);
  return () => {
    for (const [type, listener] of listeners) source.removeEventListener(type, listener);
    source.close();
    onConnection(false);
  };
}
