import { buildApiServer } from "./server.js";
import { createControlPlaneRuntime } from "./runtime.js";
import { assertSecureControlPlaneBind } from "./security.js";
import { resolveAdvertisedA2aBaseUrl } from "./a2a.js";

const host = process.env.AGENT2AGENT_HOST ?? "127.0.0.1";
const port = readPort(process.env.AGENT2AGENT_PORT, 8787);
const apiToken = process.env.AGENT2AGENT_API_TOKEN?.trim() || undefined;
assertSecureControlPlaneBind(host, apiToken);
const a2aBaseUrl = resolveAdvertisedA2aBaseUrl(host, port, process.env.AGENT2AGENT_A2A_BASE_URL);

const runtime = await createControlPlaneRuntime();
const app = buildApiServer(runtime, {
  ...(apiToken ? { apiToken } : {}),
  a2aBaseUrl,
});

await app.listen({ host, port });
console.log(`Agent2Agent control plane listening on http://${host}:${port}`);
console.log(`Agent2Agent A2A endpoint advertised at ${a2aBaseUrl}/a2a`);

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await app.close();
  await runtime.close();
};
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });

function readPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`Invalid AGENT2AGENT_PORT: ${value}`);
  return parsed;
}
