import { buildApiServer } from "./server.js";
import { createControlPlaneRuntime } from "./runtime.js";

const runtime = await createControlPlaneRuntime();
const app = buildApiServer(runtime);
const host = process.env.AGENT2AGENT_HOST ?? "127.0.0.1";
const port = readPort(process.env.AGENT2AGENT_PORT, 8787);

await app.listen({ host, port });
console.log(`Agent2Agent control plane listening on http://${host}:${port}`);

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
