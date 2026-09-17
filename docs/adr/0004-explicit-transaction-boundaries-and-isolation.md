# 0004 — Explicit transaction boundaries and isolation

**Status:** accepted · 2026-09-17

## Context
An earlier design let use cases open their own transactions, and had a scheduler call a
use case from inside the scheduler's own transaction. That puts two connections on the
same rows: the inner one waits for locks the outer one holds, forever, and Postgres cannot
detect it because one edge of the wait cycle is in application code. The design also never
stated an isolation level, although the stock-reservation invariant depends on one.

## Decision
- `Tx` is a parameter. Use cases never open transactions; controllers and jobs do, through
  `UnitOfWork.withTransaction`. No implicit propagation, no savepoints.
- Default isolation is **READ COMMITTED**, set explicitly with
  `BEGIN ISOLATION LEVEL READ COMMITTED`. Callers may request another level.
- Every pooled connection starts with `lock_timeout=5s` and `statement_timeout=15s`
  (configurable), passed in the connection startup packet so no connection can miss them.

## Why READ COMMITTED
The reservation step is a single conditional statement
(`UPDATE … SET available = available - q WHERE … AND available >= q`). Under READ COMMITTED
a concurrent update makes Postgres re-check the `WHERE` against the newest row version, so
the statement is atomic and needs no retry. Under REPEATABLE READ the same statement fails
with `40001` and every caller would need a retry loop. **Raising the isolation level
therefore requires adding retry handling first.**

## Consequences
- The transaction boundary is visible in every signature.
- A lock wait can never hang a request or job: it fails after 5s with a logged error.
- Tests assert the settings (`test/platform/transaction-settings.spec.ts`).
