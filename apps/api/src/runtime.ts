import {
  AgentRegistry,
  EventStore,
  createMonotonicIdFactory,
} from "../../../packages/core/src/index.js";
import {
  defaultLocalCliDiscoveryHost,
  discoverAndRegisterLocalCliAgents,
} from "../../../packages/adapters/src/index.js";
import {
  bootstrapCatalog,
  bootstrapMissingRuntimes,
  type InstallExecutor,
} from "../../../packages/bootstrap/src/index.js";
import {
  discoverAcpEndpoints,
  registerAcpEndpoints,
  setAcpEndpointTrust,
  type CustomAcpEndpointInput,
  type DiscoveredAcpEndpoint,
} from "../../../packages/acp/src/discovery.js";
import type { AcpConnector, AcpTrustStatus } from "../../../packages/acp/src/index.js";
import {
  ConversationRuntime,
  InMemoryConversationRepository,
} from "../../../packages/conversation/src/index.js";
import { ConversationDispatcher } from "../../../packages/conversation/src/dispatcher.js";
import type { RegisteredAgent } from "../../../packages/protocol/src/index.js";

export interface ControlPlaneRuntime {
  nodeId: string;
  startedAt: string;
  events: EventStore;
  registry: AgentRegistry;
  conversations: ConversationRuntime;
  dispatcher: ConversationDispatcher;
  trustAgent(agentId: string, trustStatus: AcpTrustStatus): Promise<RegisteredAgent>;
  close(): Promise<void>;
}

export interface CreateControlPlaneRuntimeOptions {
  nodeId?: string;
  autoInstall?: boolean;
  enableAcp?: boolean;
  desiredRuntimeIds?: string[];
  customAcpEndpoints?: CustomAcpEndpointInput[];
  installExecutor?: InstallExecutor;
  acpConnector?: AcpConnector;
  env?: Record<string, string | undefined>;
}

export async function createControlPlaneRuntime(options: CreateControlPlaneRuntimeOptions = {}): Promise<ControlPlaneRuntime> {
  const env = options.env ?? process.env;
  const nodeId = options.nodeId ?? env.AGENT2AGENT_NODE_ID ?? "local";
  const id = createMonotonicIdFactory(nodeId);
  const events = new EventStore(nodeId, id);
  const registry = new AgentRegistry(events);
  const startedAt = new Date().toISOString();
  const enableAcp = options.enableAcp ?? true;

  if (options.autoInstall !== false) {
    const installedExecutables = await detectBootstrapExecutables();
    try {
      const result = await bootstrapMissingRuntimes({
        installedExecutables,
        enableAcp,
        ...(options.desiredRuntimeIds ? { desiredRuntimeIds: options.desiredRuntimeIds } : {}),
        env,
        ...(options.installExecutor ? { execute: options.installExecutor } : {}),
      });
      for (const runtimeId of result.installed) {
        events.publish("package.installed", { runtimeId, source: "automatic-bootstrap" });
      }
    } catch (error) {
      events.publish("package.updated", {
        status: "bootstrap-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await discoverAndRegisterLocalCliAgents({ registry, nodeId });

  let endpoints: DiscoveredAcpEndpoint[] = [];
  if (enableAcp) {
    endpoints = await discoverAcpEndpoints({
      host: defaultLocalCliDiscoveryHost,
      customEndpoints: options.customAcpEndpoints ?? parseCustomAcpEndpoints(env.AGENT2AGENT_ACP_ENDPOINTS_JSON),
    });
    await registerAcpEndpoints({
      registry,
      nodeId,
      endpoints,
      ...(options.acpConnector ? { connector: options.acpConnector } : {}),
    });
  }

  const conversations = new ConversationRuntime({
    nodeId,
    id,
    events,
    repository: new InMemoryConversationRepository(),
    humanParticipantId: env.AGENT2AGENT_HUMAN_ID ?? "human:operator",
  });
  const dispatcher = new ConversationDispatcher({
    registry,
    conversations,
    events,
    maxAgentHops: readPositiveInteger(env.AGENT2AGENT_MAX_CONVERSATION_HOPS, 6),
    maxActiveSessions: readPositiveInteger(env.AGENT2AGENT_MAX_CONVERSATION_SESSIONS, 64),
  });

  return {
    nodeId,
    startedAt,
    events,
    registry,
    conversations,
    dispatcher,
    async trustAgent(agentId, trustStatus) {
      const updated = await setAcpEndpointTrust({ registry, endpoints, agentId, trustStatus });
      events.publish("agent.connected", {
        agentId: updated.id,
        trustStatus,
        reason: "trust-transition",
      }, { agentId: updated.id });
      return updated;
    },
    async close() {
      await dispatcher.close();
    },
  };
}

async function detectBootstrapExecutables(): Promise<string[]> {
  const names = new Set<string>();
  for (const recipe of [...bootstrapCatalog.runtimes, ...bootstrapCatalog.acp]) names.add(recipe.executable);
  const installed = await Promise.all([...names].map(async (name) => {
    const path = await defaultLocalCliDiscoveryHost.locate(name);
    return path ? name : undefined;
  }));
  return installed.filter((value): value is string => value !== undefined);
}

function parseCustomAcpEndpoints(value: string | undefined): CustomAcpEndpointInput[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("AGENT2AGENT_ACP_ENDPOINTS_JSON must contain valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("AGENT2AGENT_ACP_ENDPOINTS_JSON must be an array");
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`ACP endpoint ${index} must be an object`);
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.type !== "string" || typeof record.command !== "string") {
      throw new Error(`ACP endpoint ${index} requires string id, type and command`);
    }
    const args = record.args;
    if (args !== undefined && (!Array.isArray(args) || !args.every((item) => typeof item === "string"))) {
      throw new Error(`ACP endpoint ${index} args must be a string array`);
    }
    const trustStatus = record.trustStatus;
    if (trustStatus !== undefined && trustStatus !== "trusted" && trustStatus !== "pending-trust" && trustStatus !== "disabled") {
      throw new Error(`ACP endpoint ${index} has invalid trustStatus`);
    }
    return {
      id: record.id,
      type: record.type,
      command: record.command,
      ...(args ? { args: args as string[] } : {}),
      ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
      ...(trustStatus ? { trustStatus } : {}),
    };
  });
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Expected positive integer, got ${value}`);
  return parsed;
}
