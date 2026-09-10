import { A2A_PROTOCOL_VERSION, type AgentCard, type Part } from "@a2a-js/sdk";
import type { AgentAdapter, RegisteredAgent } from "../../protocol/src/index.js";

export interface A2aRegistry {
  list(): RegisteredAgent[];
  get(id: string): RegisteredAgent;
  register(agent: RegisteredAgent): RegisteredAgent;
  registerAdapter(adapter: AgentAdapter): void;
}

export function a2aTextPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    mediaType: "text/plain",
    filename: "",
    metadata: {},
  };
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A2A base URL must use http or https");
  if (url.username || url.password) throw new Error("A2A base URL must not contain credentials");
  return url.toString().replace(/\/$/, "");
}

export function validateRemoteUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A2A peer URL must use http or https");
  if (url.username || url.password) throw new Error("A2A peer URL must not contain embedded credentials");
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedMetadataHost(hostname)) {
    throw new Error(`A2A peer URL targets a blocked metadata or link-local endpoint: ${hostname}`);
  }
  return url;
}

export function assertSameA2aOrigin(cardUrl: URL, interfaceUrl: URL): void {
  if (cardUrl.origin !== interfaceUrl.origin) {
    throw new Error(`A2A Agent Card interface origin ${interfaceUrl.origin} does not match discovery origin ${cardUrl.origin}`);
  }
}

export function trustStatus(agent: RegisteredAgent): "trusted" | "pending-trust" | "disabled" {
  const value = agent.metadata.trustStatus;
  return value === "pending-trust" || value === "disabled" ? value : "trusted";
}

export function preferredProtocolVersion(card: AgentCard): string {
  return card.supportedInterfaces.find((entry) => entry.protocolVersion === A2A_PROTOCOL_VERSION)?.protocolVersion
    ?? card.supportedInterfaces[0]?.protocolVersion
    ?? A2A_PROTOCOL_VERSION;
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeHostname(value: string): string {
  const lower = value.trim().toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

function isBlockedMetadataHost(hostname: string): boolean {
  const blockedNames = new Set([
    "metadata.google.internal",
    "metadata.google",
    "instance-data.ec2.internal",
  ]);
  if (blockedNames.has(hostname)) return true;
  if (hostname === "169.254.169.254" || hostname === "169.254.170.2" || hostname === "100.100.100.200") return true;
  if (hostname === "fd00:ec2::254") return true;
  return isIpv6LinkLocal(hostname);
}

function isIpv6LinkLocal(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  const first = hostname.split(":", 1)[0];
  if (!first) return false;
  const value = Number.parseInt(first, 16);
  return Number.isFinite(value) && value >= 0xfe80 && value <= 0xfebf;
}
