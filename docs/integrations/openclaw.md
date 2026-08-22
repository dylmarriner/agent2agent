# OpenClaw integration

Verified 2026-08-22 against OpenClaw documentation and repository.

Current release evidence inspected includes the 2026.7.1-2 release train. OpenClaw documents a Gateway WebSocket/RPC control plane for external apps and separate typed plugin SDK surfaces for code running inside OpenClaw. It also exposes session/runtime helpers and embedded agent execution to trusted plugins.

Preferred integration:
1. external Agent2Agent node -> OpenClaw Gateway client/protocol
2. optional native OpenClaw plugin -> Agent2Agent MCP/A2A bridge for deeper in-process integration
3. CLI only as an operational fallback

Do not import OpenClaw private internals from an external adapter.

Sources:
- https://github.com/openclaw/openclaw
- https://docs.openclaw.ai/concepts/openclaw-sdk
- https://docs.openclaw.ai/gateway/protocol
- https://docs.openclaw.ai/plugins/sdk-runtime
