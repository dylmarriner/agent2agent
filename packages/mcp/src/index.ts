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
