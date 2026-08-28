import { spawn } from "node:child_process";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentContext,
  AgentHealth,
  AgentRequest,
  AgentResponse,
  AgentSession,
  AgentSessionOptions,
  RegisteredAgent,
} from "../../protocol/src/index.js";

export interface CommandSpec {
  executable: string;
  args: string[];
  resumeArgs?: (sessionId: string, prompt: string) => string[];
  authStatusArgs?: string[];
  output: "text" | "json" | "jsonl";
  responseParser?: "claude-json" | "codex-jsonl" | "openclaw-json" | "text";
  preferredIntegration: "sdk" | "gateway" | "http" | "cli" | "mcp";
  authentication?: "local-session" | "external";
}

export interface ProductAdapterDescriptor {
  type: string;
  command?: CommandSpec;
  notes: string;
}

export const productAdapters: Record<string, ProductAdapterDescriptor> = {
  hermes: {
    type: "hermes",
    command: {
      executable: "hermes",
      args: ["chat", "-q", "{prompt}"],
      resumeArgs: (sessionId, prompt) => ["chat", "--resume", sessionId, "-q", prompt],
      authStatusArgs: ["auth", "status"],
      output: "text",
      responseParser: "text",
      preferredIntegration: "mcp",
      authentication: "external",
    },
    notes: "Expose Agent2Agent as MCP to Hermes where possible; direct CLI is the fallback. Hermes also supports isolated worktrees natively.",
  },
  openclaw: {
    type: "openclaw",
    command: {
      executable: "openclaw",
      args: ["agent", "exec", "{prompt}", "--json"],
      authStatusArgs: ["status", "--json"],
      output: "json",
      responseParser: "openclaw-json",
      preferredIntegration: "gateway",
      authentication: "external",
    },
    notes: "Prefer the documented OpenClaw Gateway for durable sessions; `openclaw agent exec --json` is the concrete local headless fallback and uses the user's existing OpenClaw configuration.",
  },
  opencode: {
    type: "opencode",
    command: {
      executable: "opencode",
      args: ["run", "--format", "json", "{prompt}"],
      resumeArgs: (sessionId, prompt) => ["run", "--format", "json", "--session", sessionId, prompt],
      authStatusArgs: ["auth", "list"],
      output: "jsonl",
      preferredIntegration: "http",
      authentication: "external",
    },
    notes: "Prefer `opencode serve` HTTP API for durable integration; JSON CLI events are the fallback.",
  },
  "claude-code": {
    type: "claude-code",
    command: {
      executable: "claude",
      args: ["-p", "{prompt}", "--output-format", "json"],
      resumeArgs: (sessionId, prompt) => ["-p", prompt, "--resume", sessionId, "--output-format", "json"],
      authStatusArgs: ["auth", "status"],
      output: "json",
      responseParser: "claude-json",
      preferredIntegration: "cli",
      authentication: "local-session",
    },
    notes: "Use the locally installed Claude Code CLI in print mode so Agent2Agent inherits the user's existing Claude subscription login. Agent2Agent does not read or store Claude credentials or require ANTHROPIC_API_KEY.",
  },
  codex: {
    type: "codex",
    command: {
      executable: "codex",
      args: ["exec", "--json", "{prompt}"],
      resumeArgs: (sessionId, prompt) => ["exec", "resume", sessionId, "--json", prompt],
      authStatusArgs: ["login", "status"],
      output: "jsonl",
      responseParser: "codex-jsonl",
      preferredIntegration: "cli",
      authentication: "local-session",
    },
    notes: "Use the locally installed Codex CLI with its ChatGPT-managed login. Agent2Agent never needs OPENAI_API_KEY and does not read ~/.codex/auth.json.",
  },
};

export interface LocalProcessInput {
  executable: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  signal?: AbortSignal;
}

export interface LocalProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type LocalProcessExecutor = (input: LocalProcessInput) => Promise<LocalProcessResult>;

const LOCAL_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

export function localSessionEnvironment(base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env = { ...base };
  for (const key of LOCAL_AUTH_ENV_KEYS) delete env[key];
  return env;
}

export const defaultLocalProcessExecutor: LocalProcessExecutor = async (input) => new Promise((resolve, reject) => {
  const child = spawn(input.executable, input.args, {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    env: input.env,
    shell: false,
    windowsHide: true,
    ...(input.signal ? { signal: input.signal } : {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const maxBytes = 10 * 1024 * 1024;
  const append = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString("utf8");
    if (Buffer.byteLength(next, "utf8") > maxBytes) {
      child.kill("SIGKILL");
      throw new Error(`Local agent output exceeded ${maxBytes} bytes`);
    }
    return next;
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    try { stdout = append(stdout, chunk); } catch (error) { reject(error); }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    try { stderr = append(stderr, chunk); } catch (error) { reject(error); }
  });
  child.on("error", reject);
  child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
});

interface LocalSessionState {
  options: AgentSessionOptions;
}

export class LocalAuthenticatedCliAdapter implements AgentAdapter {
  readonly type: string;
  private sessionCounter = 0;
  private readonly sessions = new Map<string, LocalSessionState>();

  constructor(
    private readonly descriptor: ProductAdapterDescriptor,
    private readonly execute: LocalProcessExecutor = defaultLocalProcessExecutor,
  ) {
    if (!descriptor.command) throw new Error(`Adapter ${descriptor.type} has no local CLI command`);
    this.type = descriptor.type;
  }

  async discover(): Promise<AgentCapabilities> {
    const command = this.command();
    return {
      capabilities: ["ask", "delegate", "research", "review", "critique", "verify", "test", "debug", "improve", "compare", "challenge", "summarize", "synthesize"],
      supportsStreaming: command.output === "jsonl",
      supportsSessions: Boolean(command.resumeArgs),
      supportsCancellation: true,
      supportsTools: true,
    };
  }

  async healthCheck(_agent: RegisteredAgent): Promise<AgentHealth> {
    const command = this.command();
    const args = command.authStatusArgs ?? ["--version"];
    try {
      const result = await this.execute({ executable: command.executable, args, env: localSessionEnvironment() });
      return {
        ok: result.exitCode === 0,
        message: result.exitCode === 0 ? "local CLI available and authenticated" : (result.stderr.trim() || result.stdout.trim() || "local CLI authentication unavailable"),
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
    }
  }

  async createSession(agent: RegisteredAgent, options: AgentSessionOptions): Promise<AgentSession> {
    const session: AgentSession = { id: `local-${this.type}-${++this.sessionCounter}`, agentId: agent.id, createdAt: new Date().toISOString() };
    this.sessions.set(session.id, { options });
    return session;
  }

  async send(session: AgentSession, request: AgentRequest, context: AgentContext): Promise<AgentResponse> {
    const command = this.command();
    const prompt = requestToPrompt(request);
    const args = session.vendorSessionId && command.resumeArgs
      ? command.resumeArgs(session.vendorSessionId, prompt)
      : command.args.map((arg) => arg === "{prompt}" ? prompt : arg);
    const state = this.sessions.get(session.id);
    const cwd = stringMetadata(context.metadata?.cwd) ?? stringMetadata(state?.options.metadata?.cwd);
    const env = command.authentication === "local-session" ? localSessionEnvironment() : { ...process.env };
    const delegationDepth = nonNegativeIntegerMetadata(context.metadata?.agent2agentDelegationDepth);
    if (delegationDepth !== undefined) env.AGENT2AGENT_DELEGATION_DEPTH = String(delegationDepth);
    const result = await this.execute({
      executable: command.executable,
      args,
      env,
      ...(cwd ? { cwd } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`${this.type} local CLI failed: ${detail}`);
    }
    const parsed = parseLocalResponse(command, result.stdout);
    if (parsed.sessionId) session.vendorSessionId = parsed.sessionId;
    return {
      content: [{ type: "text", text: parsed.text }],
      artifacts: [],
      ...(parsed.vendorMessageId ? { vendorMessageId: parsed.vendorMessageId } : {}),
    };
  }

  async terminateSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  private command(): CommandSpec {
    const command = this.descriptor.command;
    if (!command) throw new Error(`Adapter ${this.descriptor.type} has no local CLI command`);
    return command;
  }
}

function requestToPrompt(request: AgentRequest): string {
  return request.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "json") return JSON.stringify(part.value);
    return part.uri;
  }).join("\n\n");
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeIntegerMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseLocalResponse(command: CommandSpec, stdout: string): { text: string; sessionId?: string; vendorMessageId?: string } {
  const parser = command.responseParser ?? (command.output === "text" ? "text" : undefined);
  if (parser === "claude-json") {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const result = typeof value.result === "string" ? value.result : JSON.stringify(value);
    const sessionId = typeof value.session_id === "string" ? value.session_id : undefined;
    const vendorMessageId = typeof value.message_id === "string" ? value.message_id : undefined;
    return { text: result, ...(sessionId ? { sessionId } : {}), ...(vendorMessageId ? { vendorMessageId } : {}) };
  }
  if (parser === "codex-jsonl") {
    let sessionId: string | undefined;
    let vendorMessageId: string | undefined;
    const texts: string[] = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
      const item = event.item;
      if (event.type === "item.completed" && item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (record.type === "agent_message" && typeof record.text === "string") texts.push(record.text);
        if (typeof record.id === "string") vendorMessageId = record.id;
      }
    }
    return { text: texts.join("\n").trim() || stdout.trim(), ...(sessionId ? { sessionId } : {}), ...(vendorMessageId ? { vendorMessageId } : {}) };
  }
  if (parser === "openclaw-json") {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const final = typeof value.final === "string"
      ? value.final
      : typeof value.response === "string"
        ? value.response
        : typeof value.message === "string"
          ? value.message
          : JSON.stringify(value);
    const sessionId = typeof value.sessionId === "string" ? value.sessionId : undefined;
    return { text: final, ...(sessionId ? { sessionId } : {}) };
  }
  return { text: stdout.trim() };
}

export type DeterministicHandler = (agent: RegisteredAgent, request: AgentRequest, context: AgentContext) => Promise<AgentResponse> | AgentResponse;

export class DeterministicAdapter implements AgentAdapter {
  readonly type = "deterministic";
  private sessionCounter = 0;

  constructor(private readonly handlers: Record<string, DeterministicHandler>) {}

  async discover(): Promise<AgentCapabilities> {
    return { capabilities: ["ask", "delegate", "review", "test", "research"], supportsStreaming: false, supportsSessions: true, supportsCancellation: false, supportsTools: false };
  }

  async healthCheck(): Promise<AgentHealth> { return { ok: true, checkedAt: new Date().toISOString() }; }

  async createSession(agent: RegisteredAgent, _options: AgentSessionOptions): Promise<AgentSession> {
    return { id: `session-${++this.sessionCounter}`, agentId: agent.id, createdAt: new Date().toISOString() };
  }

  async send(session: AgentSession, request: AgentRequest, context: AgentContext): Promise<AgentResponse> {
    const handler = this.handlers[session.agentId];
    if (!handler) return { content: [{ type: "text", text: `${session.agentId} received ${request.intent}` }], artifacts: [] };
    return handler({ id: session.agentId } as RegisteredAgent, request, context);
  }
}

export interface LocalAgentRegistry {
  registerAdapter(adapter: AgentAdapter): void;
  register(agent: RegisteredAgent): RegisteredAgent;
  list(): RegisteredAgent[];
}

export interface DiscoverAndRegisterLocalCliAgentsOptions {
  registry: LocalAgentRegistry;
  nodeId: string;
  host?: import("./discovery.js").LocalCliDiscoveryHost;
}

const LOCAL_AGENT_IDS: Record<string, string> = {
  "claude-code": "claude-local",
  codex: "codex-local",
  hermes: "hermes-local",
  opencode: "opencode-local",
  openclaw: "openclaw-local",
};

const LOCAL_AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code Local",
  codex: "Codex Local",
  hermes: "Hermes Local",
  opencode: "OpenCode Local",
  openclaw: "OpenClaw Local",
};

export async function discoverAndRegisterLocalCliAgents(
  options: DiscoverAndRegisterLocalCliAgentsOptions,
): Promise<RegisteredAgent[]> {
  const { discoverLocalCliAgents } = await import("./discovery.js");
  const discovered = await discoverLocalCliAgents({ ...(options.host ? { host: options.host } : {}) });
  const currentAgents = options.registry.list();
  const adapterTypes = new Set(currentAgents.map((agent) => agent.adapterType));
  const registered: RegisteredAgent[] = [];

  for (const runtime of discovered) {
    const descriptor = productAdapters[runtime.type];
    const id = LOCAL_AGENT_IDS[runtime.type];
    if (!descriptor?.command || !id) continue;

    const existing = currentAgents.find((agent) => agent.id === id);
    if (existing) {
      registered.push(existing);
      continue;
    }

    const resolvedDescriptor: ProductAdapterDescriptor = {
      ...descriptor,
      command: { ...descriptor.command, executable: runtime.executablePath },
    };
    const adapter = new LocalAuthenticatedCliAdapter(resolvedDescriptor);
    if (!adapterTypes.has(adapter.type)) {
      options.registry.registerAdapter(adapter);
      adapterTypes.add(adapter.type);
    }
    const capabilities = await adapter.discover();
    const agent = options.registry.register({
      id,
      nodeId: options.nodeId,
      canonicalUri: `a2a://${options.nodeId}/agents/${id}`,
      name: LOCAL_AGENT_NAMES[runtime.type] ?? runtime.type,
      adapterType: runtime.type,
      capabilities: capabilities.capabilities,
      status: runtime.authStatus === "authenticated" ? "idle" : "degraded",
      ephemeral: false,
      metadata: {
        source: "local-cli-discovery",
        executablePath: runtime.executablePath,
        ...(runtime.version ? { version: runtime.version } : {}),
        authStatus: runtime.authStatus,
        supportsStreaming: runtime.supportsStreaming,
        supportsSessions: runtime.supportsSessions,
        supportsCancellation: runtime.supportsCancellation,
        supportsTools: runtime.supportsTools,
        supportsMcp: runtime.supportsMcp,
      },
    });
    currentAgents.push(agent);
    registered.push(agent);
  }

  return registered;
}

export * from "./discovery.js";
