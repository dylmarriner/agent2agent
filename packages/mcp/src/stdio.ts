import { startLocalCollectiveMcpStdio } from "./index.js";

void startLocalCollectiveMcpStdio()
  .then(() => {
    console.error("Agent2Agent MCP stdio server ready");
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
