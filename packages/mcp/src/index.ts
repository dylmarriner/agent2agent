import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { AgentRegistry, EventStore, createMonotonicIdFactory } from "../../core/src/index.js";
import { discoverAndRegisterLocalCliAgents } from "../../adapters/src/index.js";
import {
  createCollectiveToolGateway,
  type CollectiveToolGateway,
} from "../../orchestration/src/index.js";

const listAgentsInput = z.object({
  capability: z.string().min(1).optional(),
});

const findAgentInput = z.object({
  query: z.string().min(1).optional(),
  capability: z.string().min(1).optional(),
});

const askAgentInput = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});

export function registerCollectiveMcpTools(server: McpServer, gateway: CollectiveToolGateway): void {
  server.registerTool(
    "list_agents",
    {
      title: "List Agent2Agent agents",
      description: "List agents currently registered in the Agent2Agent collective, optionally filtered by capability.",
      inputSchema: listAgentsInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ capability }) => {
      const output = { agents: gateway.listAgents({ ...(capability ? { capability } : {}) }) };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "find_agent",
    {
      title: "Find Agent2Agent agent",
      description: "Find collective agents by name, ID, adapter, URI, or capability.",
      inputSchema: findAgentInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ query, capability }) => {
      const output = {
        agents: gateway.findAgent({
          ...(query ? { query } : {}),
          ...(capability ? { capability } : {}),
        }),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "ask_agent",
    {
      title: "Ask Agent2Agent agent",
      description: "Send a prompt to one selected Agent2Agent agent through its registered adapter and return the response.",
      inputSchema: askAgentInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ agentId, prompt, conversationId, taskId, workspaceId }) => {
      const output = await gateway.askAgent({
        agentId,
        prompt,
        ...(conversationId ? { conversationId } : {}),
        ...(taskId ? { taskId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

export function buildCollectiveMcpServer(gateway: CollectiveToolGateway): McpServer {
  const server = new McpServer({ name: "agent2agent", version: "0.1.0" });
  registerCollectiveMcpTools(server, gateway);
  return server;
}

export function serveCollectiveMcpStdio(gateway: CollectiveToolGateway): StdioServerHandle {
  return serveStdio(() => buildCollectiveMcpServer(gateway));
}

export interface LocalCollectiveMcpRuntime {
  nodeId: string;
  registry: AgentRegistry;
  gateway: CollectiveToolGateway;
}

export async function createLocalCollectiveMcpRuntime(nodeId = process.env.AGENT2AGENT_NODE_ID ?? "local"): Promise<LocalCollectiveMcpRuntime> {
  const id = createMonotonicIdFactory(nodeId);
  const events = new EventStore(nodeId, id);
  const registry = new AgentRegistry(events);
  await discoverAndRegisterLocalCliAgents({ registry, nodeId });
  return { nodeId, registry, gateway: createCollectiveToolGateway({ registry, id }) };
}

export async function startLocalCollectiveMcpStdio(): Promise<StdioServerHandle> {
  const runtime = await createLocalCollectiveMcpRuntime();
  return serveCollectiveMcpStdio(runtime.gateway);
}

export interface McpRegistrationCommands {
  claude: string[];
  codex: string[];
}

export function buildMcpRegistrationCommands(repoRoot: string): McpRegistrationCommands {
  const serverPath = resolve(repoRoot, "dist/packages/mcp/src/stdio.js");
  return {
    claude: ["claude", "mcp", "add", "agent2agent", "--scope", "user", "--", "node", serverPath],
    codex: ["codex", "mcp", "add", "agent2agent", "--", "node", serverPath],
  };
}

export type McpHost = keyof McpRegistrationCommands;

export function parseMcpInstallHosts(args: string[]): McpHost[] {
  const target = args[0] ?? "both";
  if (target === "both") return ["claude", "codex"];
  if (target === "claude" || target === "codex") return [target];
  throw new Error("MCP install target must be one of: claude, codex, both");
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandExecutor = (command: string, args: string[]) => Promise<CommandResult>;

export interface InstallMcpHostsOptions {
  repoRoot: string;
  hosts: McpHost[];
  execute?: CommandExecutor;
}

export async function installMcpHosts(options: InstallMcpHostsOptions): Promise<Partial<Record<McpHost, CommandResult>>> {
  const commands = buildMcpRegistrationCommands(options.repoRoot);
  const execute = options.execute ?? executeCommand;
  const results: Partial<Record<McpHost, CommandResult>> = {};

  for (const host of options.hosts) {
    const argv = commands[host];
    const result = await execute(argv[0]!, argv.slice(1));
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`Failed to register Agent2Agent MCP with ${host}: ${detail}`);
    }
    results[host] = result;
  }

  return results;
}

export const executeCommand: CommandExecutor = async (command, args) => new Promise((resolveResult, reject) => {
  const child = spawn(command, args, {
    shell: false,
    windowsHide: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.on("error", reject);
  child.on("close", (code) => resolveResult({ exitCode: code ?? 1, stdout, stderr }));
});
