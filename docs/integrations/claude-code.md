# Claude Code integration

Verified 2026-08-22.

The former Claude Code SDK is now the Claude Agent SDK. The TypeScript package is `@anthropic-ai/claude-agent-sdk`; version 0.3.238 was current when verified. The SDK exposes Claude Code-style autonomous execution programmatically and documents sessions, permissions, MCP integration, custom tools and subagents.

Preferred integration: use the Claude Agent SDK rather than terminal scraping. Map SDK session IDs, tool events, artifacts, usage and cancellation into canonical Agent2Agent execution records.

Sources:
- https://github.com/anthropics/claude-agent-sdk-typescript
- https://platform.claude.com/docs/en/agent-sdk/overview
- https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
