# OpenCode integration

Verified 2026-08-22 against opencode.ai documentation.

Useful current surfaces:
- `opencode run ... --format json` for programmatic CLI execution
- `--session` / `--continue` / `--fork` session controls
- `opencode serve` for a headless HTTP API
- MCP support
- explicit agent permission configuration

Preferred integration: use the headless server/API for durable sessions and event-driven integration. Use JSON CLI mode as a fallback when only a local binary is available.

Sources:
- https://opencode.ai/docs/
- https://opencode.ai/docs/cli/
