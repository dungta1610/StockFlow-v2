# 0013 — Atomic reservation, one transaction per order, one lock order

**Status:** accepted · 2026-09-18

## Context
StockFlow's `CreateOrder` inserted the order and its lines and committed. It never touched
stock. `inventory_reservations` had a model and no caller, and cancel/expire only changed
the status. Any number of orders could be placed for the last unit.

v2 has to make "never oversell" an invariant that a test proves under concurrency (50
orders racing for 10 units). The usual way to do that is to read each stock row
`SELECT … FOR UPDATE`, check it, then write. It also has to answer two questions that
StockFlow never faced: what undoes a half-reserved order, and in which order do rows get
locked, so that four write paths (create, cancel/expire/fulfil, adjust, the expiry sweep)
cannot deadlock one another.

## Decision
**Reserve with the conditional update from ADR 0012, one per line, inside the order's
transaction.**
```sql
UPDATE inventory SET available_qty = available_qty - $3, reserved_qty = reserved_qty + $3, …
 WHERE product_id = $1 AND warehouse_id = $2 AND available_qty >= $3
RETURNING …   -- zero rows = not enough stock, nothing changed
```
There is no read before the write. The row lock is taken by the statement that moves the
stock and held only until commit. Zero rows back means `INSUFFICIENT_STOCK` (409, with the
product, SKU, requested and available quantities). The use case throws, and the
transaction rollback undoes every line reserved before it. There is no compensation code.

**Why not reserve through a separate service call.** Rollback undoes earlier lines
*because* everything is in one transaction. Put reservation behind an HTTP or queue
boundary and that atomicity is gone: the undo would have to be a saga, with its own
failure modes, to solve a problem a modular monolith does not have.

**Write order inside create:** authorise → price → insert order and lines → reserve, line
by line in product-id order → insert reservations → outbox. Stock is reserved last, so
its row locks are held for the shortest possible time. The ledger row of each reserve
movement already points at the reservation, which is inserted after every line has been
held. That foreign key (`fk_itx_reservation`) is `DEFERRABLE INITIALLY DEFERRED` for
exactly this reason. It is checked at commit, when the reservation exists.

**One lock order for the whole system:**

> `orders` (by id) → that order's `inventory_reservations` → `inventory` (by product id)

| Path | How it complies |
|---|---|
| create order | locks no existing order; stock rows in product-id order |
| cancel / expire / mark-paid / fulfil | `SELECT … FOR UPDATE` on the order first, then its held reservations, then stock in product-id order |
| expiry sweep (phase 05) | calls the same expire use case, one order per transaction |
| adjust stock | one row, one statement; holds nothing across statements |

An order draws from one warehouse, so product-id order is a total order over the stock
rows it touches. Two carts that list the same products in opposite order lock them the
same way.

**A status change settles the whole order or nothing.** The order row lock *is* the
claim. A second worker waits on it, then sees the new status and returns without
changing anything. All held reservations are locked and settled with no `LIMIT`. There
is no intermediate status like "releasing": an earlier design had one, and a crash could
leave an order stuck in it forever with its stock never returned.

## Consequences
- `no-oversell-concurrent.spec.ts` runs 10 times per suite run and asserts exact status
  counts (10 × 201, 40 × 409). A run where every request failed cannot pass.
- `no-deadlock-crossing.spec.ts` and `no-deadlock-mixed-flows.spec.ts` cover
  create-vs-create and all four paths at once. `invariant-sum.spec.ts` checks the books
  after random concurrent batches.
- Under heavy contention on one SKU, orders queue on that stock row for the length of
  one order transaction. That is the price of never overselling, and the transaction is
  kept short.
- `releaseAtomic` / `consumeAtomic` guard on the row's total reserved quantity (ADR 0012).
  Releasing only reservations still `held`, under the order lock, is what stops a
  repeated cancel from taking another order's units.
