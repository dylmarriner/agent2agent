import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentContext,
  AgentEvent,
  AgentHealth,
  AgentRequest,
  AgentResponse,
  AgentSession,
  AgentSessionOptions,
  RegisteredAgent,
} from "../../protocol/src/index.js";

export type AcpTrustStatus = "trusted" | "pending-trust" | "disabled";

export interface AcpEndpointConfig {
  id: string;
  type: string;
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  trustStatus: AcpTrustStatus;
  mcpServers?: unknown[];
}

export interface AcpConnectorHandlers {
  onUpdate(event: AgentEvent): void;
  onPermission?: AcpPermissionHandler;
}

export interface AcpPromptResult {
  stopReason: string;
  text: string;
}

export interface AcpConnection {
  capabilities: { loadSession: boolean };
  newSession(cwd: string, mcpServers?: unknown[]): Promise<string>;
  loadSession?(sessionId: string, cwd: string, mcpServers?: unknown[]): Promise<void>;
  prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<AcpPromptResult>;
  cancel(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export type AcpConnector = (config: AcpEndpointConfig, handlers: AcpConnectorHandlers) => Promise<AcpConnection>;
export type AcpPermissionHandler = (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;

export async function denyAcpPermission(_request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
  return { outcome: { outcome: "cancelled" } };
}

interface ActiveAcpSession {
  connection: AcpConnection;
  options: AgentSessionOptions;
  eventBuffer: AgentEvent[];
}

export class AcpAgentAdapter implements AgentAdapter {
  readonly type = "acp";
  private readonly sessions = new Map<string, ActiveAcpSession>();
  private sessionCounter = 0;

  constructor(
    private readonly endpoint: AcpEndpointConfig,
    private readonly connector: AcpConnector = connectAcpProcess,
    private readonly permissionHandler: AcpPermissionHandler = denyAcpPermission,
  ) {}

  async discover(): Promise<AgentCapabilities> {
    return {
      capabilities: ["ask", "delegate", "research", "review", "critique", "verify", "test", "debug", "improve", "compare", "challenge", "summarize", "synthesize"],
      supportsStreaming: true,
      supportsSessions: true,
      supportsCancellation: true,
      supportsTools: true,
    };
  }

  async healthCheck(_agent: RegisteredAgent): Promise<AgentHealth> {
    if (this.endpoint.trustStatus !== "trusted") {
      return { ok: false, message: `ACP endpoint is ${this.endpoint.trustStatus}`, checkedAt: new Date().toISOString() };
    }
    try {
      const connection = await this.connector(this.endpoint, { onUpdate() {}, onPermission: this.permissionHandler });
      await connection.close();
      return { ok: true, message: "ACP endpoint initialized", checkedAt: new Date().toISOString() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
    }
  }

  async createSession(agent: RegisteredAgent, options: AgentSessionOptions): Promise<AgentSession> {
    this.assertTrusted();
    const eventBuffer: AgentEvent[] = [];
    const connection = await this.connector(this.endpoint, {
      onUpdate(event) { eventBuffer.push(event); },
      onPermission: this.permissionHandler,
    });
    const cwd = metadataString(options.metadata?.cwd) ?? this.endpoint.cwd ?? process.cwd();
    const vendorSessionId = await connection.newSession(cwd, this.endpoint.mcpServers);
    const session: AgentSession = {
      id: `acp-${this.endpoint.id}-${++this.sessionCounter}`,
      agentId: agent.id,
      vendorSessionId,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, { connection, options, eventBuffer });
    return session;
  }

  async send(session: AgentSession, request: AgentRequest, context: AgentContext): Promise<AgentResponse> {
    this.assertTrusted();
    const active = this.sessions.get(session.id);
    if (!active) throw new Error(`Unknown ACP session ${session.id}`);
    const vendorSessionId = session.vendorSessionId;
    if (!vendorSessionId) throw new Error(`ACP session ${session.id} has no vendor session id`);
    const text = request.content.map((part) => part.type === "text" ? part.text : part.type === "json" ? JSON.stringify(part.value) : part.uri).join("\n\n");
    const onAbort = (): void => { void active.connection.cancel(vendorSessionId); };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await active.connection.prompt(vendorSessionId, text, context.signal);
      return { content: [{ type: "text", text: result.text }], artifacts: [] };
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
    }
  }

  async *stream(session: AgentSession, request: AgentRequest, context: AgentContext): AsyncIterable<AgentEvent> {
    this.assertTrusted();
    const active = this.sessions.get(session.id);
    if (!active) throw new Error(`Unknown ACP session ${session.id}`);
    active.eventBuffer.splice(0, active.eventBuffer.length);
    await this.send(session, request, context);
    for (const event of active.eventBuffer) yield event;
  }

  async terminateSession(sessionId: string): Promise<void> {
    const active = this.sessions.get(sessionId);
    if (!active) return;
    this.sessions.delete(sessionId);
    await active.connection.close();
  }

  private assertTrusted(): void {
    if (this.endpoint.trustStatus !== "trusted") throw new Error(`ACP endpoint ${this.endpoint.id} is not trusted`);
  }
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const connectAcpProcess: AcpConnector = async (config, handlers) => {
  const child = spawn(config.command, config.args, {
    ...(config.cwd ? { cwd: config.cwd } : {}),
    env: { ...process.env, ...(config.env ?? {}) },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child.stdin || !child.stdout) throw new Error(`ACP endpoint ${config.id} did not expose stdio`);
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );

  let context: acp.ClientContext | undefined;
  let capabilities = { loadSession: false };
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: unknown) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveShutdown: (() => void) | undefined;
  const shutdown = new Promise<void>((resolve) => { resolveShutdown = resolve; });
  const updateListeners = new Map<string, Array<(event: AgentEvent) => void>>();

  const app = acp.client({ name: "agent2agent" })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      return (handlers.onPermission ?? denyAcpPermission)(ctx.params);
    })
    .onNotification(acp.methods.client.session.update, async (ctx) => {
      const event = normalizeAcpUpdate(ctx.params);
      handlers.onUpdate(event);
      for (const listener of updateListeners.get(ctx.params.sessionId) ?? []) listener(event);
    });

  const run = app.connectWith(stream, async (ctx) => {
    context = ctx;
    const initialized = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    capabilities = { loadSession: initialized.agentCapabilities?.loadSession === true };
    resolveReady?.();
    await shutdown;
  }).catch((error: unknown) => {
    rejectReady?.(error);
    throw error;
  });

  child.on("error", (error) => rejectReady?.(error));
  child.stderr?.on("data", () => {});
  await ready;
  if (!context) throw new Error(`ACP endpoint ${config.id} failed to initialize`);

  const requireContext = (): acp.ClientContext => {
    if (!context) throw new Error(`ACP endpoint ${config.id} is closed`);
    return context;
  };

  return {
    capabilities,
    async newSession(cwd, mcpServers = []) {
      const response = await requireContext().request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: mcpServers as acp.McpServer[],
      });
      return response.sessionId;
    },
    async loadSession(sessionId, cwd, mcpServers = []) {
      if (!capabilities.loadSession) throw new Error(`ACP endpoint ${config.id} does not support session/load`);
      await requireContext().request(acp.methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers: mcpServers as acp.McpServer[],
      });
    },
    async prompt(sessionId, text, _signal) {
      const texts: string[] = [];
      const listener = (event: AgentEvent): void => {
        if (event.type === "delta" && event.data && typeof event.data === "object") {
          const chunk = (event.data as { text?: unknown }).text;
          if (typeof chunk === "string") texts.push(chunk);
        }
      };
      const listeners = updateListeners.get(sessionId) ?? [];
      listeners.push(listener);
      updateListeners.set(sessionId, listeners);
      try {
        const response = await requireContext().request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        return { stopReason: String(response.stopReason), text: texts.join("") };
      } finally {
        const current = updateListeners.get(sessionId) ?? [];
        updateListeners.set(sessionId, current.filter((item) => item !== listener));
      }
    },
    async cancel(sessionId) {
      await requireContext().notify(acp.methods.agent.session.cancel, { sessionId });
    },
    async close() {
      context = undefined;
      resolveShutdown?.();
      try { await stream.writable.close(); } catch { /* already closed */ }
      if (!child.killed) child.kill("SIGTERM");
      try { await run; } catch { /* closure propagates through caller operations */ }
    },
  };
};

function normalizeAcpUpdate(notification: acp.SessionNotification): AgentEvent {
  const update = notification.update as Record<string, unknown> & { sessionUpdate?: string };
  const at = new Date().toISOString();
  if (update.sessionUpdate === "agent_message_chunk") {
    const content = update.content as { type?: string; text?: string } | undefined;
    return { type: "delta", data: { sessionId: notification.sessionId, text: content?.type === "text" ? content.text ?? "" : "" }, at };
  }
  if (update.sessionUpdate === "tool_call") return { type: "tool-call", data: { sessionId: notification.sessionId, update }, at };
  if (update.sessionUpdate === "tool_call_update") return { type: "tool-result", data: { sessionId: notification.sessionId, update }, at };
  if (update.sessionUpdate === "plan") return { type: "status", data: { sessionId: notification.sessionId, update }, at };
  return { type: "status", data: { sessionId: notification.sessionId, update }, at };
}
