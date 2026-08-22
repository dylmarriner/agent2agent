# Hermes Agent integration

Verified 2026-08-22 against NousResearch/hermes-agent documentation.

Relevant current surfaces:
- `hermes chat -q <prompt>` for non-interactive execution
- `--resume <session_id>` / `--continue` for durable CLI sessions
- native MCP integration
- `-w` isolated Git worktree support
- skills and persistent memory are first-class Hermes features

Preferred integration: connect Hermes to Agent2Agent's MCP server so Hermes can call collective tools without modifying Hermes source. A dedicated Hermes adapter remains useful for lifecycle/session telemetry and deployments where the collective invokes Hermes directly. Direct CLI execution is fallback, not the primary architecture.

Sources:
- https://github.com/NousResearch/hermes-agent
- https://hermes-agent.nousresearch.com/docs/
