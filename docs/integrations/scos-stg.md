# SCOS / STG memory integration

Verified 2026-08-22 against `scos-lab/stg-engine` main.

Current package metadata reports `stg-engine` 0.6.0a1, Python >=3.10, with `networkx`, `numpy` and `stl-parser`. The project is alpha. Its public README describes spreading activation, confidence/salience separation, Hebbian learning, pruning, SQLite-backed `.stg` persistence, executable skills and an optional FastAPI HTTP server.

## Licensing constraint

STG uses BUSL-1.1. The repository states personal, academic, non-profit, government, freelancer and open-source use is free, while for-profit commercial use requires a separate commercial license. The stated change date is 2030-04-07 to Apache-2.0 for the referenced version. Deployment must therefore make STG optional and separately licenseable.

## Integration decision

- PostgreSQL is authoritative.
- STG is a `CognitiveMemoryProvider`, never the sole datastore.
- A Python sidecar is preferred for direct engine access when enabled.
- Agent2Agent persists canonical memory IDs and provenance even if STG is offline.
- retrieval frequency affects salience/usefulness but never automatically increases truth confidence.
- a PostgreSQL/pgvector fallback must remain operational during STG failure.

Sources:
- https://github.com/scos-lab/stg-engine
- https://github.com/scos-lab/stg-engine/blob/main/pyproject.toml
