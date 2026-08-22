import { CollectiveError } from "../../core/src/index.js";
import type { AgentPermissionPolicy } from "../../protocol/src/index.js";

export class PermissionEngine {
  assertNetwork(policy: AgentPermissionPolicy, hostname: string): void {
    if (!policy.network.allowedHosts.includes(hostname)) throw new CollectiveError("network_denied", `Network access to ${hostname} denied`);
  }

  assertShell(policy: AgentPermissionPolicy, command: string): void {
    if (!policy.shell.allowed) throw new CollectiveError("shell_denied", "Shell execution denied");
    if (policy.shell.allowedCommands && !policy.shell.allowedCommands.includes(command)) throw new CollectiveError("shell_command_denied", `Command ${command} denied`);
  }

  assertMemoryScope(policy: AgentPermissionPolicy, scope: AgentPermissionPolicy["memory"]["readScopes"][number]): void {
    if (!policy.memory.readScopes.includes(scope)) throw new CollectiveError("memory_scope_denied", `Memory scope ${scope} denied`);
  }
}

export function assertSafeHttpTarget(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  const privatePatterns = [/^localhost$/, /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./, /^::1$/, /^fc/i, /^fd/i, /^fe80:/i];
  if (!["http:", "https:"].includes(url.protocol)) throw new CollectiveError("ssrf_scheme", "Only http/https destinations are permitted");
  if (privatePatterns.some((pattern) => pattern.test(hostname))) throw new CollectiveError("ssrf_private", "Private or loopback destinations require an explicit trusted transport policy");
}
