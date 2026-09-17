# Code Review: Phase 03, Inventory Core & Ledger (uncommitted changes)

Date: 2026-09-18 · Reviewer: code-reviewer · Mode: report only (no source, test or doc edits)

## Scope

- Files: `db/migrations/005_inventory.sql`; `apps/api/src/modules/inventory/**` (14 files, 810 LOC);
  `apps/api/src/cli/seed-catalog.ts`, `seed.ts`; `apps/api/src/app.module.ts`;
  `packages/contracts/src/inventory.ts` + `index.ts`; `apps/api/test/inventory/**` (6 files, 580 LOC);
  `apps/api/test/identity/seed.spec.ts`; `docs/adr/0012-two-write-mechanisms-for-inventory.md`;
  `docs/code-standards.md`.
- Reference read: `StockFlow/module/inventory/{model,storage,biz}` (Go original), ADR 0004, ADR 0012,
  `phase-03-inventory-core-ledger.md` (incl. the as-built deviation table).
- Checks run:
  - `pnpm lint` — clean.
  - `pnpm typecheck` — clean in all 4 workspace projects (including `apps/web`, which consumes contracts).
  - `pnpm --filter @stockflow/api exec vitest run test/inventory test/identity` — 19 files, 145 tests, all pass.
  - `pnpm --filter @stockflow/api exec vitest run` (full suite) — **39 files, 306 tests, all pass**. Matches the
    as-built claim; no regression to phases 00/01/02.
  - Three read-only SQL probes against the project's dev Postgres (`stockflow-v2-postgres-1`), each wrapped in
    `BEGIN … ROLLBACK` so nothing was persisted. They confirm H1, H3 and M1 below. No repo files were touched.

## Overall Assessment

The concurrency work is the strongest part of this phase and it is genuinely correct for the paths that exist
today. The four write paths are single conditional statements, READ COMMITTED re-checks the `WHERE` against the
newest row version, `RETURNING` computes before/after from the post-update tuple (verified arithmetic for all
four), and the two concurrency tests are real tests — neither can be satisfied by an all-failure run. The race
in the Go original is genuinely fixed. Migration 005 matches the Go schema column for column. Authorization is
layered correctly and I found no way for a buyer to reach stock data.

Three things block a clean hand-off to Phase 04, all in the same area: **the null contract that Phase 04 is
explicitly told to build on is not actually what the code delivers.** `adjustAtomic` returning `null` leaves a
new row behind (H1, verified), the primitives accept `qty = 0` and negative quantities and respond by either
lying or poisoning the caller's transaction (H3, verified), and the "every inventory change writes a ledger row"
invariant is enforced by nothing but caller discipline while the module exports the unguarded primitives (H2).
None of these produce bad data today, because the only caller is one HTTP endpoint that rolls back on failure.
All three become live defects the moment Phase 04 writes its first multi-line transaction.

## Critical Issues

None. No trust-boundary defect, no data loss, no breaking change to a shipped contract.

## High Priority

### H1. `adjustAtomic` breaks its own null contract: a failed adjustment leaves an `inventory` row with no ledger row (verified by running it)

- **Where:** `apps/api/src/modules/inventory/infrastructure/sql-inventory.repository.ts:72-88`
  (the `INSERT … ON CONFLICT DO NOTHING` at :73-78 runs unconditionally, before the guarded `UPDATE`).
- **Contract it violates:** `application/ports/inventory.repository.ts:5-10` — "`null` always means the same
  thing: **the condition did not hold and nothing changed** — no row was created, updated or locked."
  `docs/code-standards.md:66-68` repeats it. ADR 0012:30-32 rejects `INSERT … ON CONFLICT DO UPDATE`
  specifically because it would "create a phantom row at zero" — the accepted design does exactly that.
- **Verified:** probe on a never-stocked pair with `delta = -10`, inside one transaction:
  ```
  INSERT 0 1            -- statement 1 created the row
  UPDATE 0              -- statement 2 matched nothing  => the repository returns null
  what                                       | inventory_rows | ledger_rows
  phantom row left behind by a failed adjust |              1 |           0
  ```
- **Failure scenario:** Phase 04 (or a bulk-adjust endpoint, or a Phase 08 agent tool) adjusts several lines in
  one transaction and treats `NOT_ENOUGH_STOCK` as a per-line result rather than aborting the request — a normal
  design for "adjust 30 SKUs, tell me which ones failed". On commit, every failed line leaves a zero-level
  `inventory` row with no ledger row. The phase's headline invariant is broken, `GET /inventories` starts
  listing pairs that were never stocked, and ledger-vs-level reconciliation no longer balances. Today's tests
  cannot see this: `test/inventory/adjust-stock.spec.ts:108-115` goes through the controller, whose
  `uow.withTransaction` rolls the phantom row away.
- **Fix:** run the seeding insert only when it cannot be followed by a failing update:
  ```ts
  if (delta > 0) { await tx.query(`INSERT … ON CONFLICT DO NOTHING`, [productId, warehouseId]); }
  const [row] = await tx.query<MoveRow>(`UPDATE inventory … WHERE … AND available_qty + $3 >= 0 RETURNING …`, …);
  ```
  With `delta > 0` the update after the insert always matches, so no phantom is possible; with `delta < 0` and no
  row, the update matches nothing on its own and `null` then means what it says. It also removes a pointless
  write from the negative-delta path. Add a test that calls `adjustAtomic` directly inside a transaction that
  **commits** and asserts `inventory` is still empty.
- **Also fix ADR 0012:26-32** — the "rejected alternative" paragraph currently argues against a failure mode
  that the chosen design has.

### H2. The three primitives move stock without a ledger row, and nothing enforces the pairing

- **Where:** `infrastructure/sql-inventory.repository.ts:90-126` (reserve/release/consume write only `inventory`);
  `inventory.module.ts:32` exports `InventoryRepository` to Phase 04; the ledger append lives entirely in the
  caller (`application/use-cases/adjust-stock.use-case.ts:46-58` is the only place it happens).
- **Claim being made:** `docs/code-standards.md:63-65`, ADR 0012:44-47, and the phase success criterion
  "Không đường nào sửa `inventory` mà không ghi sổ cái (kể cả seed)" — all presented as guaranteed.
- **Reality:** the guarantee is caller discipline with no type, test or database support. This phase's own tests
  already commit stock changes with no ledger rows: `test/inventory/atomic-primitives.spec.ts:44, 71, 92, 114`
  call the primitives on `uow.db`/a transaction and never append.
- **Failure scenario:** Phase 04 adds a cancellation path, a Phase 05 outbox handler, or a Phase 08 tool that
  calls `releaseAtomic` and forgets the append. Nothing fails, no test turns red, and the ledger silently stops
  reconciling with `inventory`. Because the ledger is the audit record of record and is append-only, the gap can
  never be repaired — only annotated. A hole like this is normally found months later during a stock count.
- **Fix, in order of strength:**
  1. Fold the append into the primitives: they already hold `inventoryId` and both levels, so
     `reserveAtomic(tx, productId, warehouseId, qty, ledger: { reason, createdBy, orderId, reservationId })`
     does two statements and makes the invariant unskippable. The port then has no way to move stock silently.
  2. Or enforce it in the database with a deferred constraint trigger on `inventory`.
  3. At minimum: state the caller obligation on every primitive's doc comment, and add a reconciliation test
     that replays the ledger for one row and asserts it equals the current level.

### H3. The primitives accept `qty = 0` and negative quantities; both break the contract (verified by running it)

- **Where:** `infrastructure/sql-inventory.repository.ts:90-126` and
  `application/ports/inventory.repository.ts:23-35` — no validation and no stated precondition. `adjustAtomic`'s
  caller validates (`adjust-stock.use-case.ts:31`), but the primitives are the surface Phase 04 consumes directly.
- **Verified — `qty = 0`:** `WHERE available_qty >= 0` matches, the UPDATE succeeds, the repository returns a
  `StockMove` with `before === after`:
  ```
  id | available_qty | reserved_qty | before_available | before_reserved
  …  |            10 |            2 |               10 |               2      (UPDATE 1)
  ```
  A "successful" reservation of nothing. The caller then appends the mandatory ledger row, hits
  `CHECK (quantity > 0)` (005:35), gets SQLSTATE 23514, and the **whole caller transaction is aborted** — not the
  clean `null` the contract promises.
- **Verified — `qty = -5` on reserve:** `WHERE available_qty >= -5` is true, so available *grows* by 5 and
  reserved *shrinks* by 5:
  ```
  ERROR: new row for relation "inventory" violates check constraint "chk_inventory_reserved_non_negative"
  DETAIL: Failing row contains (…, 15, -3, 3, …)
  ```
  The CHECK saved the data, but it aborted the caller's transaction. Worse: had `reserved_qty` been ≥ 5 there
  would have been **no error at all** — 5 units invented out of nothing, levels silently wrong, and the CHECK
  never consulted.
- **Regression against the Go original:** `StockFlow/module/inventory/model/inventory.go:122-124` validated
  `Quantity <= 0` in `InventoryReserve.Validate()`. That check was dropped when reserve moved into the repository.
- **Fix:** guard the top of each primitive and document the precondition:
  ```ts
  if (!Number.isSafeInteger(qty) || qty <= 0) throw InventoryErrors.invalidQuantity();
  ```
  `InventoryErrors.invalidQuantity` already exists at `domain/errors.ts:11` and is **currently unused**
  (grep-verified) — it is exactly this error. Add the negative/zero cases to `atomic-primitives.spec.ts`.

## Medium Priority

### M1. Ledger rows written in one transaction share `created_at`, so "newest first" is not ordered (verified)

- **Where:** `db/migrations/005_inventory.sql:42` — `created_at timestamptz NOT NULL DEFAULT now()`. `now()` is
  transaction start time, not statement time. `infrastructure/sql-ledger.repository.ts:90` orders by
  `created_at DESC, id DESC`, and `id` is `gen_random_uuid()`.
- **Verified:** two ledger rows inserted in one transaction → `distinct_created_at = 1, rows = 2`; the returned
  order was `consume` before `reserve`, which was right only by coincidence.
- **Failure scenario:** Phase 04 reserves three order lines and later consumes them inside one transaction, or a
  cancel releases then re-reserves. `GET /inventories/transactions` and `LedgerService.history` present those
  rows in random order, so an ops user — or the Phase 08 copilot summarising the history — sees consecutive rows
  whose `before/after` levels contradict each other. Paging stays stable (the uuid tiebreaker is unique), so this
  is an audit-readability defect, not a duplication one.
- **Fix:** `DEFAULT clock_timestamp()` on `inventory_transactions.created_at` (statement time, still one
  migration line), or add a `seq bigserial` and order by it. Same argument applies to `inventory.updated_at`
  (`sql-inventory.repository.ts:81, 94, 107, 119` all use `now()`), which is cosmetic by comparison.

### M2. Missing indexes on filter columns the API exposes (structural, not measured)

- **Where:** `005_inventory.sql:15, 45-47`.
  - `inventory` is indexed only by `UNIQUE (product_id, warehouse_id)`. `GET /inventories?warehouse_id=…`
    (`http/inventory.controller.ts:64` → `sql-inventory.repository.ts:150`) filters on `warehouse_id` alone; a
    composite index cannot serve its second column, so this is a sequential scan of the whole stock table
    followed by a sort on `p.sku, w.code` before `LIMIT/OFFSET`.
  - `inventory_transactions` has `(inventory_id, created_at)`, `(product_id, created_at)` and a partial
    `(order_id)`. `GET /inventories/transactions?warehouse_id=…` and `?reservation_id=…`
    (`inventory.controller.ts:94-97`) have none. The ledger is the fastest-growing table in the system: one row
    per stock movement, forever, never deleted.
- **Not measured:** the dev table holds 40 rows, so `EXPLAIN` picks a seq scan regardless. The finding is from
  reading the migration, not from a plan.
- **Fix:** `CREATE INDEX ON inventory (warehouse_id);` and
  `CREATE INDEX ON inventory_transactions (warehouse_id, created_at DESC);` in 005. Add the partial
  `(reservation_id) WHERE reservation_id IS NOT NULL` in Phase 04, when the column starts being written.

### M3. `getStatus` silently truncates at 100 warehouses and then reports a wrong total

- **Where:** `application/inventory.service.ts:51-63` — hardcoded `{ page: 1, limit: 100 }`, and `total` is
  computed by summing that page (`:60-63`).
- **Failure scenario:** a supplier with more than 100 warehouses, or any future finer-grained stock model (bins,
  lots). `StockStatus` carries no "truncated" flag, so the copilot answers "we have 4,200 units available" with
  full confidence when the real number is higher. The comment at `:54` acknowledges the cap but the code does
  not defend the total.
- **Fix:** compute the totals in SQL (`SELECT sum(available_qty), sum(reserved_qty) … WHERE product_id = $1`)
  so the number is always right regardless of how many warehouse rows are listed; or fetch `limit + 1` and put a
  `truncated: boolean` on `StockStatus`. The SQL aggregate is one query and is the honest option.

### M4. No lock ordering — the first multi-pair transaction in Phase 04 will deadlock

- **Where:** all four write paths take a row lock on `inventory` and hold it to commit
  (`sql-inventory.repository.ts:73-88, 90-126`). Nothing orders the pairs a transaction touches, and
  `UnitOfWork.withTransaction` has no retry (deliberately — ADR 0004 says raising isolation requires adding
  retries first, and the same reasoning applies to `40P01`).
- **Failure scenario:** order #1 reserves lines A then B; order #2 concurrently reserves B then A. Each holds one
  row and waits for the other; Postgres detects the cycle and aborts one with SQLSTATE 40P01, which surfaces as a
  500 to a customer who did nothing wrong. Not reachable through today's API (one pair per adjust request), but
  it is inherited by the module this phase hands over.
- **Fix:** write the rule down now, in ADR 0012 or on the port: any transaction touching more than one stock row
  must sort by `(product_id, warehouse_id)` before its first write. Optionally provide a repository helper that
  takes the whole set and does the sorting, so the rule cannot be forgotten.

### M5. `releaseAtomic` / `consumeAtomic` cannot distinguish a double-release from a legitimate one

- **Where:** `sql-inventory.repository.ts:103-126` — both guard on `WHERE id = $1 AND reserved_qty >= $2`, i.e.
  the row has enough reserved units *in total*, not that this particular reservation still holds them.
- **Failure scenario:** Phase 04 cancels an order and a retry occurs — a client retry, a Phase 05 outbox
  redelivery, or a Phase 08 tool invoked twice. The second `releaseAtomic(inventoryId, 5)` succeeds whenever any
  other order holds ≥5 reserved units on that row: 5 units move from reserved to available that nobody released,
  another order's reservation silently loses its backing, and the ledger records two identical release rows that
  both look valid. No error anywhere.
- **Why it belongs in this review:** the port doc (`ports/inventory.repository.ts:31-35`) presents
  `reserved < qty` as the whole safety condition, and Phase 04 is told to rely on the null contract for rollback
  decisions.
- **Fix:** state on both primitives that they are level arithmetic only, and that the caller must make the
  reservation state transition in the same transaction and treat *that* as the idempotency guard — e.g.
  `UPDATE inventory_reservations SET status='released' WHERE id=$1 AND status='active' RETURNING id`, and skip
  `releaseAtomic` when it returns nothing. Phase 04 should be planned with that ordering explicit.

## Low Priority

### L1. The append-only tests document intent rather than enforce it

`test/inventory/ledger-guarantees.spec.ts:7-23`. `methodsOf` reads only own prototype property names, so a method
added as an instance arrow-function field (`update = async (…) => …`) or inherited from a new base class passes
unnoticed. The second test greps the repository source for `UPDATE inventory_transactions|DELETE FROM
inventory_transactions` — a source-text assertion defeated by `DELETE  FROM`, a dynamically composed statement,
or a second repository file. The real guarantee would be at the database level: `REVOKE UPDATE, DELETE ON
inventory_transactions FROM <app role>`, asserted by a test that tries an update and expects `42501`. Worth
saying plainly in the ADR that today's tests are intent documentation.

### L2. The seed leaves one `inventory` row with no ledger row, and its test compares two derived counts

`apps/api/src/cli/seed-catalog.ts:110` — `if (inventoryId === undefined || quantity === 0) continue`, so the last
SKU at `HCM-01` gets a row at zero with no ledger entry. Defensible (nothing moved, and `CHECK (quantity > 0)`
forbids a zero-quantity ledger row), but it makes `docs/code-standards.md:64` ("including the seed") not literally
true. The backing assertion at `test/identity/seed.spec.ts:77-84` compares `count(manual_adjustment rows)` against
`count(inventory rows with available_qty > 0)` — two values both derived from the seed — instead of the expected
constant 39, and `stock.rows[0].units` is selected at `:76` and never asserted. Suggest asserting the constants
(40 rows, 39 ledger rows, the expected unit total) and either not creating the zero row or naming the exception in
code-standards.

### L3. Seed attribution depends on `SEED_USERS[0]` being the ops admin

`apps/api/src/cli/seed.ts:86-89` resolves `created_by` via `SEED_USERS[0]!.email`. Index 0 is
`ops.admin@stockflow.local` today (`seed.ts:23`), so it is correct — but reordering that array, a natural edit,
would silently attribute every opening-stock ledger row to a buyer account, in an append-only table where the
attribution can never be corrected. Select by literal email, or by the membership with role `ops_admin`.

### L4. Deviations from the Go original that the as-built section does not record

Both are improvements; the point is only that the deviation table claims to be complete.
- Reason default: `sql_inventory.go:60-63` stored `"manual_adjustment"` when reason was blank; v2 stores `''`
  (`contracts/src/inventory.ts:17`, migration default at `005:40`).
- List ordering: `sql_inventory.go:335` ordered `created_at DESC`; v2 orders `p.sku, w.code`
  (`sql-inventory.repository.ts:154`).

### L5. No inventory test for the forged-ops-actor branch of `assertRole`

`identity/domain/actor.ts:30-35` refuses an ops role claimed from a buyer org, and
`test/identity/use-case-authorization.spec.ts:34-40` exercises that with a `fakeOpsAdmin` fixture — but only for
identity use cases. The inventory module has no equivalent. Low risk (the helper is shared and the DB constraint
`chk_role_matches_org_type` makes such a membership unstorable), but the inventory services are the Phase 08 tool
surface, which is the place a forged actor would actually be attempted.

## Answers to the specific questions asked

**(a) The primitives, `adjustAtomic`, and concurrency.**

- *Before/after values:* correct in all four. Postgres `RETURNING` reports the post-update tuple, and each
  statement derives `before` from it by inverting its own delta — `available_qty - $3` for adjust,
  `available_qty + $3` / `reserved_qty - $3` for reserve, `available_qty - $2` / `reserved_qty + $2` for release,
  and for consume `available_qty` unchanged with `reserved_qty + $2`. Arithmetic checked against each `SET`
  clause, and the tests pin the values. No path reads the row first, so no read-then-write window exists.
- *Null contract:* holds for `reserveAtomic`, `releaseAtomic` and `consumeAtomic` — those are single statements,
  so zero rows means literally nothing happened. It does **not** hold for `adjustAtomic` (H1, verified). It is
  also not the only failure mode of any of them: a non-positive `qty` produces either a false success or an
  aborted transaction rather than `null` (H3, verified), and a `lock_timeout` expiry (5s, ADR 0004) raises
  `55P03` rather than returning `null` — that one is correct behaviour but is not mentioned in the port contract
  that Phase 04 is told to rely on.
- *Two concurrent adjusts:* correct. `INSERT … ON CONFLICT DO NOTHING` makes the loser wait on the winner's xid
  and then do nothing; under READ COMMITTED the following `UPDATE` re-evaluates `available_qty + $3 >= 0` against
  the newest committed row, so no update is lost and no `23505` escapes. `test/inventory/adjust-concurrency.spec.ts`
  proves it: 10 parallel `+10` on a never-stocked pair → 0 rejections, one row at 100, `version = 10`, 10 ledger
  rows with 10 distinct `after_available_qty` values. (The sub-case where the winner *rolls back* while the loser
  waits — the loser then retries its speculative insert and succeeds — follows from documented Postgres
  semantics; **I reasoned it, I did not execute it.**)
- *Adjust vs reserve, release vs consume:* safe. Every write is one statement with its own conditional `WHERE`;
  EvalPlanQual re-checks it against the updated tuple, so no interleaving produces a wrong level or a negative
  one. The two `CHECK (… >= 0)` constraints back this up and were shown to fire from raw SQL.
- *Repeated retries:* no retry logic exists and none is needed at READ COMMITTED — consistent with ADR 0004.
- *Deadlock:* not reachable today (one pair per request), reachable in Phase 04 — see M4.
- *Aborted transactions:* two reachable causes, both from unvalidated quantities (H3). A third, unverified:
  `available_qty + qty` overflowing `int4` in `releaseAtomic`, since the primitives impose no upper bound while
  the HTTP contract caps adjust at ±1,000,000 (`contracts/src/inventory.ts:10`).

**(b) Can `inventory` change without a ledger row in the same transaction?**

Today, through the shipped HTTP path: no. `AdjustStockUseCase` writes both in the caller's transaction
(`adjust-stock.use-case.ts:43-58`), and an exception between them rolls back the movement with it. Structurally:
yes, three ways — the H1 phantom row, the H2 unguarded primitives (already exercised without ledger rows by this
phase's own tests), and the seed's zero-quantity row (L2, benign). The invariant is stated as a guarantee in
three documents and enforced by nothing.

**(c) Migration 005 against the Go schema.**

Matches. The Go repo ships no `.sql`, so `storage/sql_inventory.go` and `storage/sql_inventory_transaction.go`
are the only source of truth, and they agree column for column: `inventory` = id, product_id, warehouse_id,
available_qty, reserved_qty, version, created_at, updated_at; `inventory_transactions` = the 15 columns of the
insert at `sql_inventory_transaction.go:19-33` plus `id`/`created_at`. Additions are deliberate and documented:
the two `CHECK (… >= 0)`, the `txn_type` CHECK, `CHECK (quantity > 0)`, `UNIQUE (product_id, warehouse_id)`, and
`reason NOT NULL DEFAULT ''`. Constraints verified live by `ledger-guarantees.spec.ts` and by my own probe
(`chk_inventory_reserved_non_negative` fired). `order_id`/`reservation_id` are intentionally FK-less with the
reason in the migration comment. Index gaps are M2; nothing here is wrong, only incomplete.

**(d) Authorization — can a buyer reach stock data anywhere?**

No. Three independent layers, all verified by reading:
- `@Roles('ops','ops_admin')` at class level on the controller (`inventory.controller.ts:26`), enforced by the
  global `RolesGuard` registered in `app.module.ts`.
- Every use case repeats `assertRole(actor, 'ops', 'ops_admin')`
  (`adjust-stock.use-case.ts:29`, `read-inventory.use-cases.ts:24, 40, 50`), and `assertRole`
  (`identity/domain/actor.ts:30-35`) additionally requires `orgType === 'internal'` for ops roles — so a forged
  ops claim from a buyer org fails even off-HTTP.
- Both Phase 08 surfaces do the same: `inventory.service.ts:40`, `ledger.service.ts:24`.

Nothing outside the module exposes stock — grepping `inventory` across `apps/api/src` returns only `app.module.ts`,
the seed, and comments in `catalog.service.ts` / `org-scope.ts` / `auth.decorators.ts`. Stock has no org dimension,
so there is no cross-buyer leak surface, and `chk_role_matches_org_type` makes an ops membership in a buyer org
unstorable. Tests cover the boundary at both layers (`adjust-stock.spec.ts:135-139` 403/401,
`inventory-read-api.spec.ts:86-90`, `inventory-status-service.spec.ts:95-99`). Only gap: L5.

**(e) Do the tests prove what their names claim?**

Mostly yes, and the two concurrency tests are the good kind.
- `adjust-concurrency.spec.ts:46-58` asserts zero rejections **and** 10 ledger rows **and** `version = 10`
  **and** 10 distinct `after_available_qty` values. An all-failure run fails it three different ways.
- `atomic-primitives.spec.ts:111-122` asserts exactly 10 `StockMove` **and** exactly 10 `null` **and** the final
  level `[0, 10]`. Also not satisfiable by an all-failure run. Pool `max` is 60 in tests
  (`test/setup.ts:11`), so 20 concurrent transactions genuinely overlap.
- The null-contract tests re-read the row after each `null` and assert the levels are untouched (`:57-61, 83-87,
  104-108`) — that is the right shape.

Weak or missing:
1. `atomic-primitives.spec.ts:63-66` ("returns null for a pair that has no stock row at all") asserts only the
   `null`; it never checks that no row was created. That is exactly the H1 class of bug — harmless for reserve,
   which has no insert, but it means the suite has no test that would have caught H1.
2. No test calls a primitive inside a transaction that **commits** after a `null`, which is the only way H1 is
   observable.
3. No reconciliation test: nothing asserts that replaying the ledger for a row reproduces its current level.
   That is the assertion that would make H2 enforceable.
4. No test for `qty <= 0` on any primitive (H3).
5. `ledger-guarantees.spec.ts` — see L1.
6. `seed.spec.ts:77-84` — count-against-count, see L2.
7. `inventory-read-api.spec.ts:88` passes a *product* id as `?id=` in the buyer-403 case. It passes for the
   right reason (the guard rejects before any query runs), but the fixture reads as if an inventory id were
   intended, which will mislead the next person to edit it.

**(f) Regressions to phases 01/02.**

None found. Full suite is 39 files / 306 tests green.
- `app.module.ts` — import addition only; guard order unchanged.
- `packages/contracts/src/index.ts` — `export * from './inventory'` adds `txnTypeSchema` and `TxnType` with no
  collision; `tsc` would have failed on an ambiguous re-export and all four projects typecheck clean,
  `apps/web` included.
- `seedCatalog` gained a required third parameter — a breaking signature change, but there is exactly one caller
  (`cli/seed.ts:89`, grep-verified) and it is updated. The seed stays idempotent: products upsert with
  `DO UPDATE … RETURNING` so `productIds` is always populated, and `seedStock`'s `ON CONFLICT DO NOTHING
  RETURNING id` yields nothing on a re-run, which correctly skips the ledger write as well as the stock write.
- `test/identity/seed.spec.ts` additions are additive.

## Recommended Actions

1. **H1** — make the seeding insert conditional on `delta > 0`; add a commit-after-null test; correct the
   "rejected alternative" paragraph in ADR 0012.
2. **H3** — reject non-positive/non-integer `qty` in all three primitives using the already-written
   `InventoryErrors.invalidQuantity`; document the precondition on the port; add the cases to
   `atomic-primitives.spec.ts`.
3. **H2** — decide before Phase 04 starts whether the ledger append moves inside the primitives or stays with
   the caller. If it stays, add the reconciliation test and put the obligation in every primitive's doc comment.
4. **M1** — `clock_timestamp()` (or a `seq`) for `inventory_transactions.created_at`, while migration 005 is
   still unapplied anywhere that matters.
5. **M2** — add the two missing indexes to 005.
6. **M4 / M5** — write the lock-ordering rule and the reservation-idempotency rule into ADR 0012 now, so
   Phase 04 is planned against them rather than discovering them.
7. **M3, L1–L5** — schedule; none of them blocks.

## Plan Status

`phase-03-inventory-core-ledger.md` ticks all nine success criteria. Eight are genuinely met. The one that is
not is *"Không đường nào sửa `inventory` mà không ghi sổ cái (kể cả seed)"* — see H1 and H2 — and the related
claim in the as-built table that `null` means "không thoả điều kiện, không đổi gì" is false for `adjustAtomic`
(H1, verified by execution). The as-built deviation list also omits L4. I am not editing the plan; recommend the
lead flips that criterion back and re-ticks it after H1/H2 land.

## Metrics

- Type coverage: no `any`, no `@ts-expect-error`, no lint suppressions in the new code. `pnpm typecheck` clean
  across 4 projects.
- Tests: 31 inventory tests across 6 files (matches the as-built claim); full suite 306/306 green.
- Linting: 0 issues.

## Unresolved Questions

1. Does Phase 04 intend to call `adjustAtomic` at all, or only reserve/release/consume? If adjust is single-line
   only forever, H1 stays latent — but the fix is three lines, so it is not worth the bet.
2. Is the ledger meant to be reconstructable into current levels (a true ledger), or only a movement log? The
   answer decides whether H2's fix is the reconciliation test or the stronger primitive signature.
3. Was `InventoryErrors.invalidQuantity` written for the primitives and then left unwired, or is it a leftover
   copy of the pricing error? If the former, H3 was known and dropped — worth confirming with the author.

Status: DONE_WITH_CONCERNS
Summary: Migration, authorization, ledger surface and the concurrency fix for the Go race are correct, and the
full 306-test suite plus lint and typecheck are green; three High findings — all verified by running SQL against
the project's Postgres — show that the `null` contract Phase 04 is told to depend on is not what the code
delivers.
Concerns/Blockers: H1 (`adjustAtomic` leaves a phantom `inventory` row with no ledger row when it returns null),
H3 (primitives accept `qty <= 0`, producing a false success or an aborted caller transaction), and H2 (the
"every stock change writes a ledger row" invariant has no enforcement) should be closed before Phase 04 builds
on these primitives.
