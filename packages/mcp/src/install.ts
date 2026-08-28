import { installMcpHosts, parseMcpInstallHosts } from "./index.js";

const hosts = parseMcpInstallHosts(process.argv.slice(2));

void installMcpHosts({ repoRoot: process.cwd(), hosts })
  .then((results) => {
    for (const host of hosts) {
      const result = results[host];
      const detail = result?.stdout.trim();
      console.log(`Registered Agent2Agent MCP with ${host}${detail ? `: ${detail}` : ""}`);
    }
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
