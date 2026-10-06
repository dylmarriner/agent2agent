import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { A2A_PROTOCOL_VERSION, type AgentCard, type SecurityRequirement } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from "@a2a-js/sdk/server";
import { CollectiveA2aExecutor, createCollectiveAgentCard } from "../../../packages/a2a/src/index.js";
import type { EventStore } from "../../../packages/core/src/index.js";
import type { ConversationDispatcher } from "../../../packages/conversation/src/dispatcher.js";
import type { ConversationRuntime } from "../../../packages/conversation/src/index.js";
import type { RegisteredAgent } from "../../../packages/protocol/src/index.js";

export interface A2aRouteRuntime {
  nodeId: string;
  events: EventStore;
  registry: {
    list(): RegisteredAgent[];
    get(id: string): RegisteredAgent;
  };
  conversations: ConversationRuntime;
  dispatcher: ConversationDispatcher;
}

export interface A2aRouteOptions {
  baseUrl: string;
  requiresBearerAuth?: boolean;
}

/** Registers the official A2A v1 discovery and JSON-RPC surfaces on the existing Fastify control plane. */
export function registerA2aRoutes(app: FastifyInstance, runtime: A2aRouteRuntime, options: A2aRouteOptions): void {
  const card = createCollectiveAgentCard({ nodeId: runtime.nodeId, baseUrl: options.baseUrl, registry: runtime.registry });
  if (options.requiresBearerAuth) applyBearerSecurity(card);
  const executor = new CollectiveA2aExecutor({
    nodeId: runtime.nodeId,
    registry: runtime.registry,
    conversations: runtime.conversations,
    dispatcher: runtime.dispatcher,
    events: runtime.events,
  });
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  const transport = new JsonRpcTransportHandler(requestHandler);

  app.get("/.well-known/agent-card.json", async () => requestHandler.getAgentCard());

  app.post("/a2a", async (request, reply) => {
    const requestedVersion = headerValue(request, "a2a-version") ?? A2A_PROTOCOL_VERSION;
    const requestedExtensions = splitHeader(headerValue(request, "a2a-extensions"));
    const context = new ServerCallContext({
      requestedVersion,
      ...(requestedExtensions.length ? { requestedExtensions } : {}),
    });
    const result = await transport.handle(bodyValue(request.body), context);
    if (!isAsyncGenerator(result)) return reply.send(result);
    await streamJsonRpc(reply, result);
    return reply;
  });
}

/** Resolves the externally advertised A2A base URL without ever publishing wildcard bind addresses. */
export function resolveAdvertisedA2aBaseUrl(host: string, port: number, configured?: string): string {
  const explicit = configured?.trim();
  if (explicit) return normalizeHttpBaseUrl(explicit);
  const normalizedHost = host.trim();
  if (normalizedHost === "0.0.0.0" || normalizedHost === "::" || normalizedHost === "[::]") {
    throw new Error("AGENT2AGENT_A2A_BASE_URL is required when binding to a wildcard address so Agent2Agent can advertise a reachable public A2A URL");
  }
  const address = normalizedHost.includes(":") && !normalizedHost.startsWith("[") ? `[${normalizedHost}]` : normalizedHost;
  return `http://${address}:${port}`;
}

function applyBearerSecurity(card: AgentCard): void {
  const requirement: SecurityRequirement = { schemes: { agent2agentBearer: { list: [] } } };
  card.securitySchemes = {
    ...card.securitySchemes,
    agent2agentBearer: {
      scheme: {
        $case: "httpAuthSecurityScheme",
        value: {
          description: "Bearer token required for Agent2Agent federation requests.",
          scheme: "Bearer",
          bearerFormat: "opaque",
        },
      },
    },
  };
  card.securityRequirements = [requirement];
  card.skills = card.skills.map((skill) => ({ ...skill, securityRequirements: [structuredClone(requirement)] }));
}

function normalizeHttpBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A2A advertised base URL must use http or https");
  if (url.username || url.password) throw new Error("A2A advertised base URL must not contain credentials");
  return url.toString().replace(/\/$/, "");
}

function bodyValue(value: unknown): string | Record<string, unknown> {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value.trim() || undefined : Array.isArray(value) ? value[0]?.trim() || undefined : undefined;
}

function splitHeader(value: string | undefined): string[] {
  return value ? [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))] : [];
}

function isAsyncGenerator<T>(value: unknown): value is AsyncGenerator<T, void, undefined> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}

async function streamJsonRpc(reply: FastifyReply, stream: AsyncGenerator<unknown, void, undefined>): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  try {
    for await (const event of stream) {
      if (reply.raw.destroyed) break;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (error) {
    if (!reply.raw.destroyed) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      })}\n\n`);
    }
  } finally {
    if (!reply.raw.destroyed) reply.raw.end();
  }
}
