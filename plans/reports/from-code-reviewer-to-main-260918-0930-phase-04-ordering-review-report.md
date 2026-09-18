# Phase 04 Ordering — Code Review

## Scope
- New: `db/migrations/006_ordering.sql`, `apps/api/src/modules/ordering/**` (20 files), `packages/contracts/src/ordering.ts`, 21 test files + `test/helpers/ordering-fixtures.ts`, ADR 0013–0016, `docs/decisions-vs-stockflow.md`
- Modified: platform error filter/DomainError, env schema, `.env.example`, inventory (`findLevels`, `levelsAt`), `app.module.ts`, `stock-movements.spec.ts`, `code-standards.md`
- Verification: `pnpm typecheck` clean (all 4 projects); `pnpm lint` clean. I did not run the test suite (it is already running in another process). All claims below come from reading the code and checking it against Postgres semantics.

## Overall assessment
The implementation is solid. The core invariants hold. Oversell is prevented by the conditional UPDATE, which is re-checked under READ COMMITTED. Rollback covers partial orders. Lock order is consistent across all paths. The idempotency claim is race-safe. I found **no Critical or High defects**. All four deliberate deviations are sound (reasoning below). The findings are one product-level data-exposure trade-off, two robustness gaps that Phase 05 will expose, and a few low items.

## Deliberate deviations: verdicts
1. **Key completed inside the order TX: SOUND, and better than the plan.** "Order committed" and "key completed" become one atomic fact. There is no crash window between TX-B and TX-C in which a committed order still has an `in_progress` key. If COMMIT succeeds but the ack is lost, `release()` is a no-op because of its `status='in_progress'` guard. If COMMIT fails, `complete()` rolls back with the order and `release()` marks the key `failed`. One cost: the key row is row-locked by the order TX between `complete()` and COMMIT, so a duplicate claim waits for that sub-millisecond window (see L4).
2. **Release/consume in product_id order: SOUND.** An order draws from one warehouse and `order_items` is UNIQUE (order_id, product_id), so `ORDER BY r.product_id` is a total order over the inventory rows touched. Reservation rows are only ever locked by a TX that already holds that order's row lock, so reservation lock order cannot form a cycle. I also checked comparator agreement: JS `<` on lowercase canonical UUID strings and Postgres `uuid` ordering (memcmp) give the same order. Create and transitions therefore lock stock identically.
3. **`fk_itx_reservation` DEFERRABLE INITIALLY DEFERRED: SOUND.** `StockMovementService` writes the ledger row in the same call as the move, so the reservation id has to exist before the reservation row. The only other option would be to split that service. A violation now surfaces at COMMIT. `UnitOfWork.withTransaction` catches and rethrows that error, and the idempotency release still runs. No other writer sets `reservation_id`.
4. **Order and items inserted before reserving: SOUND.** New rows are invisible to other transactions. Their foreign keys only take KEY SHARE on organizations/users/warehouses/products, and that does not conflict with any existing writer: I grepped the codebase and the only `FOR UPDATE` outside ordering is on `price_lists`, which orders do not reference. Cost: a failed order burns an order-code sequence value and leaves dead tuples. ADR 0014 accepts the gaps.

## Findings (ranked)

### Medium

**M1. INSUFFICIENT_STOCK tells buyers exact stock levels, although inventory reads are ops-only. CONFIRMED**
- Where: `create-order.use-case.ts:129-136` (`available: level.available`); `inventory.service.ts:74` (`levelsAt`, no role check); `order.service.ts:45-63` (`diagnose` returns `available` for buyer scope).
- Everywhere else, inventory is `@Roles('ops','ops_admin')` plus `assertRole` (inventory controller, read use cases).
- Scenario: a buyer POSTs `quantity: 1000000` for each SKU/warehouse and gets 409 with `available: N`. This works as a side-effect-free oracle for every product in every warehouse. It also reflects other tenants' demand, since reserved stock comes from all buyers.
- The plan explicitly specifies `{ productId, sku, requested, available }`, so this is a product decision, not a coding error. Options:
  - (a) keep it, and record the exposure in ADR 0013 / `decisions-vs-stockflow.md`;
  - (b) show `available` only when `isInternalOps(actor)`, or clamp it (e.g. `available: min(available, requested-1)`);
  - (c) remove it for buyers and keep `sku`/`requested`.

**M2. The expire use case throws on an order that is already cancelled; the plan's pseudo-code says to return it unchanged. CONFIRMED**
- Where: `order-transition.use-cases.ts:46-47`. The no-op fires only when `status === target`. Otherwise `canTransition` throws `ORDER_CANNOT_BE_EXPIRED`.
- The plan (phase-04 §"Luồng huỷ / hết hạn", line 131) says: `status đã terminal (cancelled/expired)? ⇒ trả nguyên trạng, KHÔNG lỗi` ("already terminal: return the order unchanged, no error"). This was not in your list of deliberate deviations.
- Scenario: the Phase 05 sweep builds its candidate list, then a buyer cancels, then the sweep's `ExpireOrderUseCase` throws a 409 DomainError. `no-deadlock-mixed-flows.spec.ts:118-119` already has to whitelist these as "race losers". A production sweeper that counts or logs these as failures, or retries them, will be noisy.
- Fix: for `target='expired'`, treat `cancelled` as a no-op. Either add an option such as `apply(..., { noopFrom: ['cancelled'] })`, or have ExpireOrderUseCase catch it. Keep the buyer's cancel-after-expire as a 409; the tests assert that deliberately. Either way, write the rule into ADR 0016.

**M3. `complete()` does not verify that it updated a row, so a lost key silently allows a duplicate order. PLAUSIBLE (becomes live when Phase 05's key cleanup lands)**
- Where: `sql-idempotency.repository.ts:54-61`. The UPDATE result is ignored.
- Scenario: a key row is deleted by the planned TTL cleanup, or a future stale-claim takeover, while its order TX is running. `complete()` matches 0 rows, and the order commits with no completed key. The client retries with the same key, claims it fresh, and a second order is placed.
- ADR 0015 says "No second order can come of it". That is true today only because cleanup does not exist yet.
- Fix: add `AND status = 'in_progress' RETURNING 1` to `complete()` and throw if no row comes back. The order TX then rolls back instead of committing without its key.

**M4. A crashed request leaves its key `in_progress` forever, and `Retry-After: 1` invites an endless tight retry loop. CONFIRMED (acknowledged in ADR 0015, but there is no bound yet)**
- Where: `idempotency.service.ts:53-59`, `sql-idempotency.repository.ts:32`.
- Until the Phase 05 cleanup exists, a pod killed between the claim and the release makes that key return 409 permanently.
- Fix: in Phase 05, either let the claim take over `in_progress` rows whose `updated_at` is older than the longest possible order TX, or clean them up. The takeover is only safe once M3 is fixed: the stale worker's `complete()` must fail if it no longer owns the key. The cleanest way is a claim token column checked in `complete()`/`release()`.

### Low

**L1. `expire` does not check that the hold has actually elapsed. CONFIRMED**
- `order-transition.use-cases.ts:111-114`. Ops can "expire" a 1-minute-old order.
- Probably intended: `cancel-twice-idempotent.spec.ts` expires a fresh order. But then "expired" does not always mean the TTL passed.
- Either check `reservation_expires_at <= now` in ExpireOrderUseCase, or state the rule in ADR 0016.

**L2. A paid order can never release its stock. CONFIRMED (plan-mandated)**
- `paid: ['fulfilled']` only (`order-state-machine.ts:38`).
- If the goods cannot ship, the reserved stock is stuck with no API path out. The only escape is fulfilling it, which records a false shipment.
- This is StockFlow's rule, but it needs a v1.1 escape hatch (refund/cancel-paid) or an ops runbook note.

**L3. The price audit pointer points at a mutable row. CONFIRMED**
- `order_items.price_list_item_id` points at `price_list_items`, and `SqlPriceListRepository.upsertItems` (`sql-price-list.repository.ts:116-127`) rewrites `unit_price` in place on the same id.
- The stored `order_items.unit_price` is still correct, but "which tier priced this line" can later show a different price than the one charged.
- Acceptable if documented. Otherwise make tiers immutable (insert a new row instead of updating).

**L4. The duplicate-claim wait can turn into a 500. PLAUSIBLE, low probability**
- `ON CONFLICT DO UPDATE ... WHERE` locks the conflicting row even when the WHERE clause is false (Postgres INSERT docs).
- A duplicate claim that arrives between the order TX's `complete()` and its COMMIT therefore waits. If that COMMIT stalls longer than `DB_LOCK_TIMEOUT_MS` (5s), the claim fails with 55P03 and the client gets a 500 INTERNAL_ERROR instead of a replay or 409.
- The window is tiny. Optionally map 55P03 in `claim()` to `idempotencyInProgress()`.

**L5. Numeric overflow gives a 500. PLAUSIBLE, unrealistic for VND**
- `quantity` ≤ 1,000,000 × unit_price can exceed `numeric(18,2)`. That raises 22003 on the order insert, which now runs before the reserve, so the client gets a 500.
- Validating `lineTotal`/`subtotal` < 10^16 before the insert would turn it into a 400.

**L6. Differences from the plan's service surface. CONFIRMED, informational**
- `OrderService.diagnose` takes `orderCode`; the plan says `orderId`.
- Service methods take `db` first and `scope` second; the plan says scope first.
- Consistent with repo conventions, but Phase 08 must consume the actual signatures.

**L7. AC #4 covers the sweeper with an emulation. Informational**
- `no-deadlock-mixed-flows.spec.ts:84-100` emulates the sweep: SELECT candidates, then one ExpireOrderUseCase TX per order.
- Point it at the real Phase 05 sweeper when that exists.

## Checks requested
- **(a) Acceptance criteria:** All 19 planned tests exist with the right assertions:
  - #1 asserts exact counts, 10×201 and 40×409 `INSUFFICIENT_STOCK`, runs 10 times, and also checks the ledger/held/orders counts.
  - #3 asserts all 201, which is stronger than "no 40P01".
  - #15 checks replay by status and body.
  - #16 holds the stock row and asserts 409 plus `Retry-After`.
  - #17 checks the key goes `failed` → retry succeeds → key `completed`.
  - #19 checks 404 cross-tenant for read and cancel, and ops seeing all buyers.

  Also verified:
  - No `releasing` string in `modules/ordering` (grep: 0 hits).
  - 10,000-code test present.
  - ADRs 0013–0016 present.
  - The DTO has no price field (zod strip).

  Not verified by me: that the suite is green and that #1 passes 10 consecutive runs. That depends on the run in the other process.
- **(b) Regressions:**
  - Inventory adds `findLevels` and `levelsAt`, both additive. There are no other `InventoryRepository` implementations or fakes.
  - Pricing, identity and the filter are untouched apart from the optional `headers` on DomainError; existing errors render as before.
  - The `stock-movements.spec.ts` change is required by `fk_itx_order` and is correct.
  - `adjust-stock.spec` expects `order_id: null`, which is unaffected.
- **(c) Contracts:**
  - Additive only: new exports, new env var with a default, an optional constructor param.
  - 006 adds FKs to 005's `inventory_transactions`. That is intentional, and safe only because no environment has ledger rows with orphan `order_id`s (006 is not applied anywhere yet).
- **(d) Patterns:** All conform:
  - ports/infrastructure layering;
  - use cases take `tx`;
  - `assertRole` in every write use case;
  - `OrgScope` in every read and in `lockById`;
  - Money through `fromDb`/`toString`;
  - 404-not-403 via scoped `lockById`/`findById`.

  `IdempotencyService` opening its own transactions is the documented exception (ADR 0015, code-standards §3).
- **(e) Concurrency:**
  - **Oversell:** impossible. The UPDATE's `available_qty >= $3` is re-evaluated against the latest row version after the lock wait (EvalPlanQual).
  - **Deadlock:** create locks no existing order and takes stock in product-id order. Transitions take the order, then reservations, then stock in product-id order. Adjust is one row per statement. Every foreign key an order insert creates takes KEY SHARE, which never conflicts with the NO KEY UPDATE locks the other paths use. No cycles.
  - **Idempotency claim:** a loser waits on the row lock, then retries against the committed version. It then sees `in_progress`, updates nothing, reads the row, and gets a 409. First-insert races resolve through speculative insertion. The race where the SELECT sees `failed` is reported as busy, which is fine.
  - **Transitions:** a second `FOR UPDATE` re-reads the latest status, and the idempotent no-op fires.
- **(f) SQL:**
  - `INSERT ... SELECT $1, * FROM unnest(...)` is correct. Postgres does not resolve unknown-typed parameters in INSERT...SELECT, so `$1` takes the column's uuid type. Column order matches.
  - The reservations unnest has explicit casts.
  - `select()` numbering is correct: findById/findByCode use `$1`, then scope `$2`. `list` binds filters, then scope, then `pagingSql`, all into the same `params`.
  - `listExpiring` uses `[until, limit]` and then scope `$3`, which is correct.
  - Paging is capped at 100 by `pagingQuerySchema`.
  - Items for a page are fetched in one query (no N+1).

## Recommended actions
1. Decide M1 (product call) and record it in the ADR.
2. Fix M3 now (a one-line `RETURNING` plus a throw). It is the prerequisite for M4's Phase 05 cleanup/takeover.
3. Resolve M2 before Phase 05 builds the sweeper.
4. Document L1 and L2 in ADR 0016.

## Unresolved questions
1. M1: should buyers see exact `available` in INSUFFICIENT_STOCK and in `diagnose`, when every inventory endpoint is ops-only?
2. M2: when the sweeper expires an order that is already cancelled, should that be a silent no-op (plan line 131) or a 409 (current code)?
3. L1: is ops-initiated `expire` before the TTL intended, or should it be restricted to overdue holds?
4. Idempotency keys are scoped per organisation, not per user: two users in one org who reuse a key get each other's replay. Intended? ADR 0015 says per organisation, which is consistent, so I'm only confirming.

Status: DONE_WITH_CONCERNS
Summary: No Critical or High defects. Oversell prevention, lock ordering, rollback and the idempotency claim are correct, and all four deliberate deviations are sound. Typecheck and lint are clean.
Concerns/Blockers: M1 (buyers can read exact stock through INSUFFICIENT_STOCK) needs a product decision. M3 and M2 should be fixed before Phase 05 adds key cleanup and the sweeper.
