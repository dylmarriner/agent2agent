# Database

`migrations/0001_initial.sql` is the initial PostgreSQL + pgvector schema for authoritative Agent2Agent state. It deliberately keeps cognitive-memory data separate from transactional truth while retaining canonical IDs and provenance links.

Apply to a fresh PostgreSQL 17 + pgvector database with:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/migrations/0001_initial.sql
```
