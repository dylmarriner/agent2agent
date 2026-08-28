import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { CollectiveError } from "../../../packages/core/src/index.js";
import type { CollaborationIntent, CollectiveEvent, RegisteredAgent } from "../../../packages/protocol/src/index.js";
import type { AcpTrustStatus } from "../../../packages/acp/src/index.js";
import type { ControlPlaneRuntime } from "./runtime.js";

export type { ControlPlaneRuntime } from "./runtime.js";

export interface PublicAgentDto {
  id: string;
  name: string;
  canonicalUri: string;
  adapterType: string;
  status: RegisteredAgent["status"];
  capabilities: string[];
  transportTypes: string[];
  trustStatus: AcpTrustStatus | "trusted";
  version?: string;
  authStatus?: string;
  supportsAcp: boolean;
  supportsMcp: boolean;
  supportsStreaming: boolean;
  supportsSessions: boolean;
  supportsCancellation: boolean;
  supportsTools: boolean;
}

const collaborationIntents = new Set<CollaborationIntent>([
  "ask", "delegate", "research", "review", "critique", "verify", "test", "debug",
  "improve", "compare", "challenge", "teach", "summarize", "vote", "synthesize",
  "spawn-specialist", "merge-findings", "request-memory", "publish-knowledge", "request-skill",
]);

export function buildApiServer(runtime: ControlPlaneRuntime): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  app.setErrorHandler((error: unknown, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const isCollective = error instanceof CollectiveError;
    const statusCode = isCollective
      ? error.code.endsWith("not_found") || error.code === "agent_not_found" ? 404 : 400
      : /not backed by a discovered ACP endpoint|Unknown agent|Unknown conversation/i.test(message) ? 404 : 500;
    void reply.code(statusCode).send({
      error: {
        code: isCollective ? error.code : statusCode === 500 ? "internal_error" : "not_found",
        message: statusCode === 500 ? "Internal control-plane error" : message,
      },
    });
  });

  app.get("/api/v1/system/health", async () => ({
    ok: true,
    nodeId: runtime.nodeId,
    startedAt: runtime.startedAt,
    uptimeMs: Math.max(0, Date.now() - Date.parse(runtime.startedAt)),
    agents: runtime.registry.list().length,
    conversations: (await runtime.conversations.list()).length,
    events: runtime.events.list().length,
  }));

  app.get("/api/v1/agents", async () => ({ agents: runtime.registry.list().map(toPublicAgent) }));

  app.get("/api/v1/agents/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { agent: toPublicAgent(runtime.registry.get(id)) };
  });

  app.post("/api/v1/agents/:id/trust", async (request) => {
    const { id } = request.params as { id: string };
    const body = objectBody(request.body);
    const trustStatus = body.trustStatus;
    if (trustStatus !== "trusted" && trustStatus !== "pending-trust" && trustStatus !== "disabled") {
      throw new CollectiveError("trust_status", "trustStatus must be trusted, pending-trust, or disabled");
    }
    const agent = await runtime.trustAgent(id, trustStatus);
    return { agent: toPublicAgent(agent) };
  });

  app.get("/api/v1/conversations", async () => ({ conversations: await runtime.conversations.list() }));

  app.post("/api/v1/conversations", async (request, reply) => {
    const body = objectBody(request.body);
    const title = requiredString(body.title, "title");
    const objective = requiredString(body.objective, "objective");
    const participantIds = stringArray(body.participantIds) ?? runtime.registry.list()
      .filter(isRoutableAgent)
      .map((agent) => agent.id);
    for (const participantId of participantIds) runtime.registry.get(participantId);
    const conversation = await runtime.conversations.create({ title, objective, participantIds });
    return reply.code(201).send({ conversation });
  });

  app.get("/api/v1/conversations/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { conversation: await runtime.conversations.get(id) };
  });

  app.get("/api/v1/conversations/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    return { messages: await runtime.conversations.messages(id) };
  });

  app.post("/api/v1/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = objectBody(request.body);
    const text = requiredString(body.text, "text");
    const taskId = optionalString(body.taskId);
    const intent = parseIntent(body.intent);
    const message = await runtime.conversations.sendHumanMessage(id, {
      text,
      ...(taskId ? { taskId } : {}),
      ...(intent ? { intent } : {}),
    });

    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("HTTP request closed"));
    if (request.raw.aborted) abort();
    else request.raw.once("aborted", abort);
    try {
      const produced = await runtime.dispatcher.dispatch(message, { signal: controller.signal });
      return reply.code(202).send({ message, produced });
    } finally {
      request.raw.removeListener("aborted", abort);
    }
  });

  app.get("/api/v1/events", async (request) => {
    const query = request.query as { after?: string; limit?: string };
    const limit = parseLimit(query.limit, 500);
    return { events: eventsAfter(runtime.events.list(), query.after).slice(0, limit).map(toPublicEvent) };
  });

  app.get("/api/v1/events/stream", async (request, reply) => {
    const query = request.query as { after?: string; once?: string };
    const headerCursor = typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined;
    const after = query.after ?? headerCursor;
    const replay = eventsAfter(runtime.events.list(), after).map(toPublicEvent);
    if (query.once === "1" || query.once === "true") {
      reply.type("text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      return replay.map(formatSseEvent).join("");
    }
    streamEvents(request, reply, runtime, replay);
    return reply;
  });

  return app;
}

function streamEvents(request: FastifyRequest, reply: FastifyReply, runtime: ControlPlaneRuntime, replay: CollectiveEvent[]): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.write(": agent2agent event stream\n\n");
  for (const event of replay) reply.raw.write(formatSseEvent(event));

  const unsubscribe = runtime.events.subscribe((event) => {
    if (!reply.raw.destroyed) reply.raw.write(formatSseEvent(toPublicEvent(event)));
  });
  const heartbeat = setInterval(() => {
    if (!reply.raw.destroyed) reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);
  heartbeat.unref();

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!reply.raw.destroyed) reply.raw.end();
  };
  request.raw.once("close", close);
  reply.raw.once("error", close);
}

export function toPublicAgent(agent: RegisteredAgent): PublicAgentDto {
  const metadata = agent.metadata;
  return {
    id: agent.id,
    name: agent.name,
    canonicalUri: agent.canonicalUri,
    adapterType: agent.adapterType,
    status: agent.status,
    capabilities: [...agent.capabilities],
    transportTypes: metadataStringArray(metadata.transportTypes),
    trustStatus: metadataTrust(metadata.trustStatus),
    ...(typeof metadata.version === "string" ? { version: metadata.version } : {}),
    ...(typeof metadata.authStatus === "string" ? { authStatus: metadata.authStatus } : {}),
    supportsAcp: metadata.supportsAcp === true,
    supportsMcp: metadata.supportsMcp === true,
    supportsStreaming: metadata.supportsStreaming === true,
    supportsSessions: metadata.supportsSessions === true,
    supportsCancellation: metadata.supportsCancellation === true,
    supportsTools: metadata.supportsTools === true,
  };
}

export function toPublicEvent(event: CollectiveEvent): CollectiveEvent {
  return {
    id: event.id,
    type: event.type,
    nodeId: event.nodeId,
    at: event.at,
    data: sanitizePublicValue(event.data),
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
  };
}

export function formatSseEvent(event: CollectiveEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function eventsAfter(events: CollectiveEvent[], after?: string): CollectiveEvent[] {
  if (!after) return events;
  const index = events.findIndex((event) => event.id === after);
  return index < 0 ? events : events.slice(index + 1);
}

function sanitizePublicValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[max-depth]";
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizePublicValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitivePublicKey(key)) continue;
    output[key] = sanitizePublicValue(entry, depth + 1);
  }
  return output;
}

function isSensitivePublicKey(key: string): boolean {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return normalized.includes("password")
    || normalized.includes("secret")
    || normalized.includes("token")
    || normalized.includes("apikey")
    || normalized.includes("authorization")
    || normalized.includes("credential")
    || normalized === "env"
    || normalized === "executablepath";
}

function isRoutableAgent(agent: RegisteredAgent): boolean {
  const trust = metadataTrust(agent.metadata.trustStatus);
  return trust === "trusted" && (agent.status === "idle" || agent.status === "busy");
}

function metadataTrust(value: unknown): AcpTrustStatus | "trusted" {
  return value === "pending-trust" || value === "disabled" || value === "trusted" ? value : "trusted";
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CollectiveError("request_body", "JSON object body is required");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CollectiveError("request_field", `${field} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseIntent(value: unknown): CollaborationIntent | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !collaborationIntents.has(value as CollaborationIntent)) {
    throw new CollectiveError("request_field", "intent is not a supported collaboration intent");
  }
  return value as CollaborationIntent;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new CollectiveError("request_field", "participantIds must be a non-empty string array");
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2000) throw new CollectiveError("request_field", "limit must be an integer between 1 and 2000");
  return parsed;
}
