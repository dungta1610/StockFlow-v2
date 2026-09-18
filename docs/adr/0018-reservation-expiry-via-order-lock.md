# 0018 — Reservation expiry: read ids outside a transaction, claim by order lock

**Status:** accepted · 2026-09-19

## Context
An order holds stock for `ORDER_RESERVATION_TTL_MINUTES`; something has to release
it if the buyer never pays. An earlier version of this job opened one transaction
for the whole sweep, moved each reservation to a `releasing` status inside it, and
then called `ExpireOrderUseCase` — which, per docs/adr/0004, opens its *own*
transaction. That is two connections touching the same rows: the inner transaction
waits for a lock the outer one holds, forever, and Postgres cannot detect the
deadlock because one edge of the cycle is application code, not a row lock graph
the database can see. `releasing` was also a dead end: nothing ever moved a
reservation out of it if the process died there.

## Decision
- **Read outside a transaction:** `SELECT id, reservation_expires_at FROM orders
  WHERE status = 'reserved' AND reservation_expires_at < now() ORDER BY
  reservation_expires_at, id LIMIT $batch` runs as a plain autocommit read
  (`UnitOfWork.db`), not inside any transaction the job holds. Soonest-expiring
  first, matching the port's own doc comment (`OrderRepository.listReservedExpired`).
- **One transaction per order**, via `UnitOfWork.withTransaction`, calling
  `ExpireOrderUseCase.execute(tx, systemActor, { orderId })` — the exact use case
  `POST /orders/:id/expire` uses. There is never a transaction open across more
  than one order.
- **The order's row lock is the claim.** `OrderTransitions.apply` already does
  `SELECT … FOR UPDATE` on the order before touching anything (docs-standards'
  system lock order: orders → that order's reservations → inventory by product
  id). No new intermediate status is needed: the lock itself is exclusive, and the
  use case is already idempotent for cancel/expire (docs/adr/0016) — a second
  sweep, or a buyer's own cancel, racing the first one finds the order already
  `expired` or `cancelled` and returns it unchanged.
- **A batch limits orders, never lines.** `RESERVATION_SWEEP_BATCH` bounds how many
  order ids one run reads; each selected order's *entire* set of reservations is
  released in its own transaction; a three-line order is never half-released
  because a batch boundary fell in the middle of it.
- **A cursor across runs stops a persistently failing order from starving the
  orders behind it.** `ReservationExpiryJob` keeps `(reservation_expires_at, id)`
  of the last order it attempted, success or failure, and passes it as `after` to
  the next run's read. Without this, `ORDER BY … LIMIT batch` with no memory of
  earlier attempts would re-select the same stuck orders every run forever — the
  batch always fills with the same ids that already failed, and the healthy order
  behind them never gets a turn. The cursor resets to the start once a run reads
  fewer than a full batch (it reached the end of the currently expired set), so
  newly-expired orders are picked up on the next pass.
- **`systemActor`** (`modules/identity/domain/actor.ts`) is ops rights scoped to
  every buyer organisation (`OrgScope` `all-buyers`), defined once so the sweep —
  and any future job — never invents its own bypass of `assertRole`/`orgScopeOf`.
  A `paid` order is filtered out twice: the sweep's own `WHERE status = 'reserved'`
  and `canTransition('paid', 'expired') === false` inside the use case.
- **`lock_timeout = 5s` is the last line of defence**, not the mechanism: if some
  other path holds an order's row lock for longer than that (a bug, not an
  expected state), the sweep's attempt to lock it fails with `55P03` after 5
  seconds instead of hanging, the job logs it and moves to the next order, and the
  next sweep tries again.

## Consequences
- `test/scheduler/expiry-releases-stock.spec.ts`, `expiry-releases-all-lines.spec.ts`
  and `expiry-skips-paid.spec.ts` cover the happy path, the multi-line/batch
  interaction, and the paid-order guard.
- `test/scheduler/expiry-concurrent.spec.ts` runs two sweeps over 50 expired orders
  at once and checks stock is released exactly once per order.
- `test/scheduler/no-nested-transaction.spec.ts` holds a lock on one order from a
  second connection and checks the job returns within `lock_timeout`, logs the
  failure, and leaves the rest of the batch unaffected — proof the old hang cannot
  recur.
- `test/scheduler/expiry-avoids-starvation.spec.ts` makes two orders fail every
  attempt and checks a healthy order behind them still expires on a later run.
