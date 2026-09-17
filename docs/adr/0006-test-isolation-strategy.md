# 0006 — Test isolation strategy

**Status:** accepted · 2026-09-17

## Context
The most important tests in this project prove concurrency invariants (no overselling
under 50 parallel orders). A flaky concurrency test is worse than none: once it fails
"sometimes", nobody trusts the invariant it guards. Vitest runs test files in parallel by
default, and parallel files sharing one database truncate each other's fixtures.

## Decision
- One Postgres (`pgvector/pgvector:0.8.1-pg16`, `max_connections=200`) and one Redis
  container per test run, started in Vitest `globalSetup`, with all migrations applied.
- Test files run **one at a time** (`fileParallelism: false`, a single fork).
- Before **every test**, all tables in `commerce` and `ai` are truncated and Redis is flushed.
- Tests boot the real `AppModule` through the same `configureApp()` production uses.
- No database mocks for invariant tests.

## Consequences
- The suite is slower than a parallel one; that is the price of trustworthy concurrency tests.
- Concurrency *inside* a test (many connections at once) is unaffected — only files are serialised.
- `test/platform/isolation-a.spec.ts` and `isolation-b.spec.ts` would fail if files ran
  concurrently or state leaked between tests.
