# Model Context Protocol

Verified 2026-08-22.

The TypeScript v2 SDK is stable and implements the 2026-07-28 MCP specification. Server and client are split into `@modelcontextprotocol/server` 2.0.0 and `@modelcontextprotocol/client` 2.0.0. Standard transports include stdio and Streamable HTTP.

Sources:
- https://modelcontextprotocol.io/
- https://github.com/modelcontextprotocol/typescript-sdk
- https://www.npmjs.com/package/@modelcontextprotocol/server

Integration decision: Agent2Agent exposes collective operations as MCP tools for existing agents. MCP remains an agent-to-tool/control-plane integration while A2A is used for agent-to-agent interoperability. The internal domain model is not an MCP transcript.
