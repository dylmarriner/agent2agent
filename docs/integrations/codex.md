# OpenAI Codex integration

Verified 2026-08-23.

## Default: local ChatGPT-authenticated CLI

Agent2Agent integrates with the locally installed `codex` binary by default. It does **not** require `OPENAI_API_KEY` and does not read or copy `~/.codex/auth.json`.

Codex supports ChatGPT-managed authentication. Sign in once using the Codex CLI:

```bash
codex login
```

For a headless/device-code flow where enabled:

```bash
codex login --device-auth
```

Check local auth with:

```bash
codex login status
```

Codex owns the OAuth tokens, persists them in its own local auth store, and refreshes them. Agent2Agent only invokes Codex under the same OS user.

Programmatic execution uses JSONL:

```bash
codex exec --json "<prompt>"
```

Agent2Agent captures the `thread.started` thread ID and resumes that same local Codex thread with:

```bash
codex exec resume "<thread-id>" --json "<prompt>"
```

The child environment strips `OPENAI_API_KEY` so the Agent2Agent local-subscription adapter cannot accidentally switch to API-key billing because of an inherited environment variable. The command is spawned directly without a shell and runs inside the assigned isolated worktree.

## Optional future integration: Codex app-server / SDK

Codex app-server exposes a structured JSON-RPC account/session surface and supports ChatGPT-managed auth. `@openai/codex-sdk` can also provide richer thread lifecycle integration. Those are useful future backends, but neither is required for the local no-API-key path.

Sources:
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- https://help.openai.com/en/articles/11369540/
- https://github.com/openai/codex/tree/main/sdk/typescript
