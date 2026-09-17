# 0012 — Two write mechanisms for stock, and what `version` is not

**Status:** accepted · 2026-09-18

## Context
StockFlow adjusted stock by reading the row `SELECT … FOR UPDATE` and inserting it when
the read found nothing. `FOR UPDATE` locks no row when there is no row, so the first two
adjustments for a new product/warehouse pair raced: one hit the unique index (23505) or
landed without its ledger row. Ordering (phase 04) needs something stronger again: it
must know whether a reservation succeeded without reading stock first.

## Decision
Two mechanisms, each where it fits.

**1. Adjustment (ops moving stock by hand) — for an increase, make sure the row exists,
then move it.**
```sql
-- only when $3 > 0
INSERT INTO inventory (product_id, warehouse_id, available_qty, reserved_qty, version)
VALUES ($1, $2, 0, 0, 0) ON CONFLICT (product_id, warehouse_id) DO NOTHING;

UPDATE inventory
   SET available_qty = available_qty + $3, version = version + 1, updated_at = now()
 WHERE product_id = $1 AND warehouse_id = $2 AND available_qty + $3 >= 0
RETURNING id, available_qty, reserved_qty,
          available_qty - $3 AS before_available, reserved_qty AS before_reserved;
```
Both statements are safe to race: the insert is idempotent, and the update is a single
conditional statement that Postgres re-evaluates against the committed row. A brand-new
row starts at `version = 0`, so the adjustment that follows leaves it at 1.

**A decrease never inserts.** On a pair with no row the update matches nothing and the
call returns null. Running the insert unconditionally would leave a stock row at zero
that no ledger entry explains — visible to any caller that treats a failed line as a
per-line result and commits the rest.

*Rejected:* one `INSERT … ON CONFLICT DO UPDATE`. The insert branch would have to carry
the delta, and a negative delta on a pair that has no row would either violate the
`CHECK` — which poisons the caller's transaction — or create a phantom row at zero.

**2. Reserve / release / consume — one conditional `UPDATE … RETURNING`.**
No read first, no lock held across statements. `RETURNING` reports the levels before and
after, computed from the new values, so the ledger row can never describe a state that
did not exist. Zero rows back means the condition did not hold.

**The null contract is part of the port**, not an implementation detail: `null` means
*the condition did not hold and nothing changed*. Phase 04 rolls back on that basis, and
`stock-movements.spec.ts` pins it for all three primitives, including the concurrent
case (20 racing reservations against 10 units leave exactly 10 winners and stock at 0).

**Quantities are validated before they reach SQL.** Zero would "succeed" while moving
nothing, and a negative quantity would invent stock; either way the mandatory ledger row
would then violate `CHECK (quantity > 0)` and poison the caller's whole transaction. The
primitives reject both with `400 INVALID_QUANTITY` — the Go original validated this in
its model, and the check came back when reserve moved into the repository.

**Every change to stock writes one ledger row in the same transaction — enforced, not
remembered.** `StockMovementService` is the only exported way to move stock: each method
performs the movement and appends its ledger row, and the repositories stay inside the
module. The ledger port has `append` and `list` and nothing else, so no caller — job or
agent tool — can rewrite history. A mistake is corrected by another movement, the way a
stock book works, and the seed follows the same rule: opening stock arrives with its
ledger row.

**`version` is not an optimistic lock in v1.** The Go version incremented it and never
used it as a predicate; keeping it silently would be cargo cult. It stays as an audit
counter — one movement, one version — and any future read-modify-write path that wants
`WHERE version = $n` must say so explicitly. Correctness today comes from the conditional
`WHERE` on each write, not from the counter.

**Ledger rows are stamped with `clock_timestamp()`, not `now()`.** `now()` is the
transaction's start time, so the several movements one order writes would share a
timestamp and their order would fall to a uuid tie-break.

## Consequences
- Two `CHECK (… >= 0)` constraints are the last line of defence; the write paths already
  prevent negatives, and `ledger-guarantees.spec.ts` proves the database refuses them
  even from raw SQL.
- `order_id` and `reservation_id` on the ledger have no foreign key yet: orders arrive in
  phase 04, which adds the constraints rather than making this migration depend on tables
  that do not exist.
- Two limits belong to ordering, not here, and phase 04 must handle them:
  `releaseAtomic` and `consumeAtomic` guard on the row's **total** reserved quantity, so
  a repeated release for one order could take another order's held units — the
  reservation row's status is what makes that idempotent; and a multi-line order must
  take its rows in a fixed order (by inventory id) or two carts holding the same products
  in opposite order will deadlock.
- Stock is supplier data, so the `/inventories` routes and both services are ops-only;
  buyers learn what they can order through the catalog and their quotes. `getStatus`
  takes a SKU and an optional warehouse code — the copilot in phase 08 has codes, not
  uuids — and an unknown code is a 404, never an empty result that reads as "no stock".
