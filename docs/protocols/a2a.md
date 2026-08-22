# A2A protocol

Verified 2026-08-22.

The official JavaScript SDK is `@a2a-js/sdk` 1.0.1, implementing A2A Protocol v1.0.0. It supports JSON-RPC, HTTP+JSON/REST and gRPC, with opt-in v0.3 compatibility.

Sources:
- https://a2a-protocol.org/latest/
- https://github.com/a2aproject/a2a-js
- https://www.npmjs.com/package/@a2a-js/sdk

Integration decision: keep the internal `AgentMessage`, task and event models independent from A2A objects. The A2A gateway will map Agent Cards, messages, tasks, streaming and external identifiers to canonical IDs. Federation identity remains `a2a://<node>/agents/<agent>` but peer trust is enforced separately through node policy and credentials.
