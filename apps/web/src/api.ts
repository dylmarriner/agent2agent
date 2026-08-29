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

const API_TOKEN_KEY = "agent2agent.apiToken";

export function getApiToken(): string {
  if (typeof sessionStorage === "undefined") return "";
  return sessionStorage.getItem(API_TOKEN_KEY) ?? "";
}

export function setApiToken(token: string): void {
  if (typeof sessionStorage === "undefined") return;
  const value = token.trim();
  if (value) sessionStorage.setItem(API_TOKEN_KEY, value);
  else sessionStorage.removeItem(API_TOKEN_KEY);
}

function authorizedHeaders(): Record<string, string> {
  const token = getApiToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...authorizedHeaders(),
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
  const controller = new AbortController();
  let stopped = false;
  let lastEventId = "";

  const connect = async (): Promise<void> => {
    while (!stopped) {
      try {
        const response = await fetch("/api/v1/events/stream", {
          signal: controller.signal,
          headers: {
            accept: "text/event-stream",
            ...authorizedHeaders(),
            ...(lastEventId ? { "last-event-id": lastEventId } : {}),
          },
        });
        if (!response.ok) throw new Error(`Event stream failed: ${response.status} ${response.statusText}`);
        if (!response.body) throw new Error("Event stream response had no body");
        onConnection(true);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const parsed = parseSseFrame(frame);
            if (parsed?.id) lastEventId = parsed.id;
            if (parsed?.event) onEvent(parsed.event);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (stopped || controller.signal.aborted) break;
        console.warn("Agent2Agent event stream disconnected", error);
      } finally {
        onConnection(false);
      }
      if (!stopped) await delay(1_500, controller.signal).catch(() => {});
    }
  };

  void connect();
  return () => {
    stopped = true;
    controller.abort();
    onConnection(false);
  };
}

function parseSseFrame(frame: string): { id?: string; event?: EventDto } | undefined {
  let id: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return id ? { id } : undefined;
  try {
    const event = JSON.parse(data.join("\n")) as EventDto;
    return { ...(id ? { id } : {}), event };
  } catch {
    return id ? { id } : undefined;
  }
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
