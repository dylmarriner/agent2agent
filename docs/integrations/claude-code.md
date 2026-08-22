# Claude Code integration

Verified 2026-08-23.

## Default: local subscription-authenticated CLI

Agent2Agent integrates with the locally installed `claude` binary by default. It does **not** require an Anthropic API key and it does not read, copy, persist, or proxy Claude credential files.

Claude Code supports account/subscription authentication through:

```bash
claude auth login
claude auth status
```

`claude auth status` exits successfully when the local CLI is logged in. Agent2Agent uses it as the adapter health/authentication probe.

Programmatic execution uses Claude Code print mode with structured output:

```bash
claude -p "<prompt>" --output-format json
```

The JSON response includes a Claude Code session ID. Agent2Agent stores only that opaque session ID on its own `AgentSession` and resumes with:

```bash
claude -p "<prompt>" --resume "<session-id>" --output-format json
```

The adapter launches the binary directly without a shell, in the assigned worktree directory, and strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and alternate Claude cloud-provider selection environment variables from the child environment. This prevents an unrelated API-key environment variable from silently changing the intended subscription-authenticated path.

Agent2Agent does not bypass Claude Code's own permission system. Worktree and agent permissions remain separate enforcement layers.

## Optional future integration: Claude Agent SDK

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) remains useful for deeper event streaming, tool lifecycle integration, MCP configuration, and programmatic subagent control. It is an optional richer backend, not a requirement for the local no-API-key path.

Sources:
- https://code.claude.com/docs/en/cli-usage
- https://code.claude.com/docs/en/headless
- https://platform.claude.com/docs/en/agent-sdk/overview
