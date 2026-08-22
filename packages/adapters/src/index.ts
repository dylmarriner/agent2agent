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
  output: "text" | "json" | "jsonl";
  preferredIntegration: "sdk" | "gateway" | "http" | "cli" | "mcp";
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
      output: "text",
      preferredIntegration: "mcp",
    },
    notes: "Expose Agent2Agent as MCP to Hermes where possible; direct CLI is the fallback. Hermes also supports isolated worktrees natively.",
  },
  openclaw: {
    type: "openclaw",
    notes: "Prefer the documented OpenClaw Gateway client/protocol for external apps; plugin runtime is for in-process integrations.",
  },
  opencode: {
    type: "opencode",
    command: {
      executable: "opencode",
      args: ["run", "--format", "json", "{prompt}"],
      resumeArgs: (sessionId, prompt) => ["run", "--format", "json", "--session", sessionId, prompt],
      output: "jsonl",
      preferredIntegration: "http",
    },
    notes: "Prefer `opencode serve` HTTP API for durable integration; JSON CLI events are the fallback.",
  },
  "claude-code": {
    type: "claude-code",
    notes: "Prefer @anthropic-ai/claude-agent-sdk for sessions, permissions, streaming, subagents and MCP integration.",
  },
  codex: {
    type: "codex",
    command: {
      executable: "codex",
      args: ["exec", "--json", "{prompt}"],
      resumeArgs: (sessionId, prompt) => ["exec", "resume", sessionId, "--json", prompt],
      output: "jsonl",
      preferredIntegration: "sdk",
    },
    notes: "Prefer @openai/codex-sdk threads; CLI JSONL remains a compatible fallback.",
  },
};

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
