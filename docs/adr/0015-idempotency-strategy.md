# 0015 — Idempotency keys: claim first, commit with the work, free on failure

**Status:** accepted · 2026-09-18

## Context
`POST /orders` accepts an `Idempotency-Key` header, so a client that times out can retry
without placing a second order. The first design claimed the key *inside* the order
transaction. That fails in two ways:
- A concurrent duplicate either blocks on the uncommitted key row, stalling the request
  path under exactly the load the concurrency tests create, or reads an `in_progress`
  row with no response yet and replays an empty body.
- A rollback for `INSUFFICIENT_STOCK` rolls the key back too. The 409 for a reused key
  would then never fire on the most common failure path.

## Decision
Three steps, three explicit key states (`in_progress`, `completed`, `failed`):

1. **Claim**: one autocommit statement, committed before any order work:
   `INSERT … ON CONFLICT DO UPDATE … WHERE status = 'failed' RETURNING`. A new key, or
   one whose last attempt failed, becomes ours. Otherwise the existing row decides:
   - different request hash → `409 IDEMPOTENCY_KEY_REUSED`
   - `in_progress` → `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1`
   - `completed` → replay the stored status and body
2. **Work**: the order transaction. The key is marked `completed`, with the response,
   **inside that same transaction**, so "the order exists" and "the key is completed"
   are one atomic fact. There is no window where the order has committed but its key
   still reads `in_progress`.
3. **Release**: if the work throws, a separate statement marks the key `failed`.

**Business failures free the key.** `INSUFFICIENT_STOCK` is exactly when a client should
fix the cart and retry. Burning the key there would be wrong, so only success locks a
key. A retry of a failed key may carry a different body, and its hash replaces the old
one.

**This is the one deliberate exception to "callers own the transaction" (ADR 0004).**
`IdempotencyService` opens its own transactions: the claim must commit before the work's
transaction opens. So nothing may call it from inside a transaction. The controller calls
it and hands it the work as a function of `tx`.

Keys are scoped by (organisation, endpoint, key): two customers may use the same key. The
request hash is SHA-256 of the validated body. Fields the schema strips, such as a
client-sent `unit_price`, are not part of it.

## Consequences
- `idempotency-key.spec.ts` checks replay by status *and* body, and checks reuse with a
  different body. `idempotency-concurrent.spec.ts` holds the stock row so the first
  request is provably still working when the second arrives. `idempotency-released-on-business-failure.spec.ts`
  covers the retry-after-fixing-the-cart path.
- If the process dies between claim and release, the key stays `in_progress` and the
  client gets 409s until the TTL cleanup (phase 05) removes it. No second order can come
  of it.
- `response_snapshot` holds only the serialised response. It is `jsonb`, so key order is
  not preserved byte for byte. Phase 05's cleanup job bounds the table's growth.
