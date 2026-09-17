# 0002 — One Postgres, two schemas, forward-only migrations

**Status:** accepted · 2026-09-17

## Context
The commerce domain and the AI harness (pgvector memory, chat sessions) both need
Postgres. StockFlow (Go) had no migrations at all — its schema existed only inside SQL
strings, so the database could not be rebuilt from the repository.

## Decision
- One Postgres instance (`pgvector/pgvector:0.8.1-pg16`) with schemas `commerce` and `ai`.
- Connections set `search_path=commerce,public`: commerce SQL stays unqualified (as in
  StockFlow); `ai` tables are always schema-qualified; extensions live in `public`.
- Migrations are numbered SQL files in `db/migrations/`, applied by a ~60-line runner
  (`platform/database/migrator.ts`): filename order, one transaction per file, recorded in
  `public.schema_migrations`, serialised with an advisory lock. Forward-only.

## Consequences
- One backup, one pool. Moving `ai` to its own database later is a connection-string change.
- Rolling back means writing a new migration.
- **Filename order is apply order.** Numbers must stay contiguous and must never be
  reordered after they have run anywhere; otherwise applied order and filename order
  diverge permanently. If phases are ever reordered, switch to timestamp prefixes first.

## Rejected
- **Two databases:** no reason yet; costs a second pool and cross-database joins become impossible.
- **A migration library:** the runner is small enough to read in full, which is part of the point.
