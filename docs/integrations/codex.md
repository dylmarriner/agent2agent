# OpenAI Codex integration

Verified 2026-08-22.

`@openai/codex-sdk` is the official TypeScript SDK for embedding Codex. Version 0.149.0 was current when verified. It wraps the Codex CLI with JSONL events and exposes `startThread()` / `resumeThread()` for durable sessions. The CLI also exposes `codex exec --json` and `codex exec resume`.

Preferred integration: use the SDK for thread lifecycle, structured output and cancellation. Keep CLI JSONL as a compatible fallback for installations where the SDK cannot be embedded.

Sources:
- https://github.com/openai/codex/tree/main/sdk/typescript
- https://www.npmjs.com/package/@openai/codex-sdk
