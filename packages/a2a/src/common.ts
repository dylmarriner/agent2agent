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
  return url;
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
