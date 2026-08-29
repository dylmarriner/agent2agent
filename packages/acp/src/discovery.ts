import type { AgentAdapter, RegisteredAgent } from "../../protocol/src/index.js";
import { AcpAgentAdapter, type AcpConnector, type AcpEndpointConfig, type AcpTrustStatus } from "./index.js";

export type AcpEndpointSource = "known" | "custom";

export interface AcpDiscoveryHost {
  locate(executable: string): Promise<string | undefined>;
  run(executable: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface CustomAcpEndpointInput {
  id: string;
  type: string;
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  trustStatus?: AcpTrustStatus;
}

export interface DiscoveredAcpEndpoint extends AcpEndpointConfig {
  source: AcpEndpointSource;
}

interface KnownAcpSpec {
  id: string;
  type: string;
  executable: string;
  args: string[];
  checkArgs?: string[];
  canonicalAgentId: string;
  name: string;
}

const KNOWN_ACP_SPECS: readonly KnownAcpSpec[] = [
  {
    id: "hermes-acp",
    type: "hermes",
    executable: "hermes",
    args: ["acp"],
    checkArgs: ["acp", "--check"],
    canonicalAgentId: "hermes-local",
    name: "Hermes Local",
  },
  {
    id: "copilot-acp",
    type: "copilot",
    executable: "copilot",
    args: ["--acp"],
    canonicalAgentId: "copilot-local",
    name: "GitHub Copilot Local",
  },
  {
    id: "goose-acp",
    type: "goose",
    executable: "goose",
    args: ["acp"],
    canonicalAgentId: "goose-local",
    name: "Goose Local",
  },
  {
    id: "antigravity-acp",
    type: "antigravity",
    executable: "agy-acp",
    args: [],
    canonicalAgentId: "antigravity-local",
    name: "Antigravity Local",
  },
] as const;

export interface DiscoverAcpEndpointsOptions {
  host: AcpDiscoveryHost;
  customEndpoints?: CustomAcpEndpointInput[];
}

export async function discoverAcpEndpoints(options: DiscoverAcpEndpointsOptions): Promise<DiscoveredAcpEndpoint[]> {
  const known = await Promise.all(KNOWN_ACP_SPECS.map(async (spec): Promise<DiscoveredAcpEndpoint | undefined> => {
    const path = await options.host.locate(spec.executable);
    if (!path) return undefined;
    if (spec.checkArgs) {
      try {
        const check = await options.host.run(path, spec.checkArgs);
        if (check.exitCode !== 0) return undefined;
      } catch {
        return undefined;
      }
    }
    return {
      id: spec.id,
      type: spec.type,
      command: path,
      args: [...spec.args],
      trustStatus: "trusted",
      source: "known",
    };
  }));

  const discoveredKnown = known.filter((value): value is DiscoveredAcpEndpoint => value !== undefined);
  const reservedEndpointIds = new Set(KNOWN_ACP_SPECS.map((spec) => spec.id));
  const reservedCanonicalIds = new Set(KNOWN_ACP_SPECS.map((spec) => spec.canonicalAgentId));
  const seenEndpointIds = new Set(discoveredKnown.map((endpoint) => endpoint.id));
  const seenCanonicalIds = new Set(discoveredKnown.map((endpoint) => canonicalIdentityFor(endpoint).id));
  const custom: DiscoveredAcpEndpoint[] = [];

  for (const input of options.customEndpoints ?? []) {
    const id = input.id.trim();
    if (!id) throw new Error("Custom ACP endpoint id is required");
    if (reservedEndpointIds.has(id) || seenEndpointIds.has(id)) {
      throw new Error(`Custom ACP endpoint id ${id} is reserved or duplicate`);
    }
    const canonicalId = id;
    if (reservedCanonicalIds.has(canonicalId) || seenCanonicalIds.has(canonicalId)) {
      throw new Error(`Custom ACP canonical identity ${canonicalId} collides with an existing agent`);
    }

    const path = await resolveConfiguredCommand(options.host, input.command);
    if (!path) continue;
    const endpoint: DiscoveredAcpEndpoint = {
      id,
      type: input.type,
      command: path,
      args: [...(input.args ?? [])],
      ...(input.env ? { env: { ...input.env } } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      trustStatus: input.trustStatus ?? "pending-trust",
      source: "custom",
    };
    custom.push(endpoint);
    seenEndpointIds.add(id);
    seenCanonicalIds.add(canonicalId);
  }

  return [...discoveredKnown, ...custom];
}

async function resolveConfiguredCommand(host: AcpDiscoveryHost, command: string): Promise<string | undefined> {
  if (command.includes("/") || command.includes("\\")) return command;
  return host.locate(command);
}

export interface AcpAgentRegistry {
  registerAdapter(adapter: AgentAdapter): void;
  register(agent: RegisteredAgent): RegisteredAgent;
  get(id: string): RegisteredAgent;
  list(): RegisteredAgent[];
  remove(id: string): void;
}

export interface RegisterAcpEndpointsOptions {
  registry: AcpAgentRegistry;
  nodeId: string;
  endpoints: DiscoveredAcpEndpoint[];
  connector?: AcpConnector;
}

export async function registerAcpEndpoints(options: RegisterAcpEndpointsOptions): Promise<RegisteredAgent[]> {
  const registered: RegisteredAgent[] = [];
  const canonicalIds = new Set<string>();

  for (const endpoint of options.endpoints) {
    const canonical = canonicalIdentityFor(endpoint);
    if (canonicalIds.has(canonical.id)) throw new Error(`Duplicate ACP canonical agent identity: ${canonical.id}`);
    canonicalIds.add(canonical.id);
    const inner = new AcpAgentAdapter(endpoint, options.connector);
    const adapter = bindAdapterType(inner, `acp:${endpoint.id}`);
    options.registry.registerAdapter(adapter);
    const capabilities = await adapter.discover({});
    const existing = options.registry.list().find((agent) => agent.id === canonical.id);
    const transportTypes = uniqueStrings([
      ...metadataStringArray(existing?.metadata.transportTypes),
      "acp",
    ]);
    const metadata: Record<string, unknown> = {
      ...(existing?.metadata ?? {}),
      source: endpoint.source === "known" ? "local-acp-discovery" : "custom-acp-discovery",
      transportTypes,
      trustStatus: endpoint.trustStatus,
      supportsAcp: true,
      acpEndpointId: endpoint.id,
      acpSource: endpoint.source,
    };

    const record: RegisteredAgent = {
      id: canonical.id,
      nodeId: existing?.nodeId ?? options.nodeId,
      canonicalUri: existing?.canonicalUri ?? `a2a://${options.nodeId}/agents/${canonical.id}`,
      name: existing?.name ?? canonical.name,
      adapterType: adapter.type,
      capabilities: uniqueStrings([...(existing?.capabilities ?? []), ...capabilities.capabilities]),
      status: endpoint.trustStatus === "trusted" ? (existing?.status === "busy" ? "busy" : "idle") : "degraded",
      ephemeral: existing?.ephemeral ?? false,
      ...(existing?.parentAgentId ? { parentAgentId: existing.parentAgentId } : {}),
      metadata,
    };

    if (existing) options.registry.remove(existing.id);
    registered.push(options.registry.register(record));
  }

  return registered;
}

export interface SetAcpEndpointTrustOptions {
  registry: AcpAgentRegistry;
  endpoints: DiscoveredAcpEndpoint[];
  agentId: string;
  trustStatus: AcpTrustStatus;
}

export async function setAcpEndpointTrust(options: SetAcpEndpointTrustOptions): Promise<RegisteredAgent> {
  const matches = options.endpoints.filter((candidate) => canonicalIdentityFor(candidate).id === options.agentId);
  if (matches.length === 0) throw new Error(`Agent ${options.agentId} is not backed by a discovered ACP endpoint`);
  if (matches.length > 1) throw new Error(`Agent ${options.agentId} has ambiguous ACP endpoint bindings`);
  const endpoint = matches[0]!;
  endpoint.trustStatus = options.trustStatus;

  const existing = options.registry.get(options.agentId);
  const updated: RegisteredAgent = {
    ...existing,
    status: options.trustStatus === "trusted" ? (existing.status === "busy" ? "busy" : "idle") : "degraded",
    metadata: {
      ...existing.metadata,
      trustStatus: options.trustStatus,
    },
  };
  options.registry.remove(existing.id);
  return options.registry.register(updated);
}

function bindAdapterType(inner: AcpAgentAdapter, type: string): AgentAdapter {
  return {
    type,
    discover: (_config) => inner.discover(),
    healthCheck: (agent) => inner.healthCheck(agent),
    createSession: (agent, sessionOptions) => inner.createSession(agent, sessionOptions),
    send: (session, request, context) => inner.send(session, request, context),
    stream: (session, request, context) => inner.stream(session, request, context),
    terminateSession: (sessionId) => inner.terminateSession(sessionId),
  };
}

export function canonicalIdentityFor(endpoint: DiscoveredAcpEndpoint): { id: string; name: string } {
  const known = KNOWN_ACP_SPECS.find((spec) => spec.id === endpoint.id);
  if (known) return { id: known.canonicalAgentId, name: known.name };
  return { id: endpoint.id, name: endpoint.id };
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export const knownAcpSpecs = KNOWN_ACP_SPECS.map((spec) => ({ ...spec, args: [...spec.args], ...(spec.checkArgs ? { checkArgs: [...spec.checkArgs] } : {}) }));
