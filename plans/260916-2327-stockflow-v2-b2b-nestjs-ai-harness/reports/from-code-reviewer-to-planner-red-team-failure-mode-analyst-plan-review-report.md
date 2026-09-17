---
title: "Red-team plan review — Failure Mode Analyst / Flow Tracer"
reviewer: code-reviewer
lens: failure-mode-analyst
tier: full (flow tracer)
date: 2026-09-17
plan: plans/260916-2327-stockflow-v2-b2b-nestjs-ai-harness
verdict: DONE_WITH_CONCERNS
---

# Red-team review: StockFlow v2 plan — failure modes, races, recovery gaps

Scope: all 13 plan files. Evidence drawn from the plan files and the two read-only reference
repos (`StockFlow/StockFlow`, `AI Harness Clone/AI-Harness-Clone`). No code exists yet, so every
citation below is a plan line or a reference-repo line.

Headline: the plan's centerpiece — "never oversell", Phase 04 — is *internally* sound for the
create-order path alone. It falls apart the moment a second actor touches the same rows: the
Phase 05 sweeper, the Phase 06 callback, and the Phase 04 cancel path form a lock cycle the plan
never analyses, and the `releasing` state the plan introduces has **no exit**. Three of the eight
acceptance criteria in `plan.md` are not provable by the test list as written.

---

## Finding 1: Sweeper holds an open transaction across a call into a use case that opens its own transaction — undetectable cross-connection hang

- **Severity:** Critical
- **Location:** Phase 05, section "Reservation expiry job"; Phase 00, section "Architecture" (UnitOfWork); Phase 04, section "Luồng huỷ / hết hạn"

**Flaw:** The sweeper pseudocode wraps the claim *and* the call to `ExpireOrderUseCase` in one
`BEGIN … COMMIT`. But every Phase 04 use case is specified as owning its own transaction
(`toàn bộ trong unitOfWork.withTransaction`), and the `UnitOfWork` contract has no way to join an
existing transaction — `withTransaction<T>(fn: (tx: Tx) => Promise<T>)` takes no `tx` and returns no
savepoint. So calling `ExpireOrderUseCase` from inside the sweeper's transaction acquires a
**second pool connection** and opens a **second transaction** that must wait for locks the first one
holds. Postgres cannot see the application-level dependency (sweeper → use case), so its deadlock
detector never fires. This is a silent hang, not a detected deadlock.

**Failure scenario:**
- T1: Buyer cancels order X. Tx `C` runs `SELECT … FROM orders WHERE id=X … FOR UPDATE` and holds the order row lock (phase-04:99).
- T2: Sweeper tx `S` runs its claim `UPDATE inventory_reservations SET status='releasing' … ORDER BY id … FOR UPDATE SKIP LOCKED` and acquires the row lock on reservation `r1`, which belongs to order X. `SKIP LOCKED` does not skip it — nobody held it yet (phase-05:84-88).
- T3: Tx `C` moves to its release block and tries to update reservation `r1` → **blocks** on `S`'s uncommitted row lock (phase-04:102-105).
- T4: Still inside its open transaction, the sweeper calls `ExpireOrderUseCase(X)`. That opens tx `E` on a *different* connection and runs `SELECT … FROM orders WHERE id=X … FOR UPDATE` → **blocks** on `C`'s order lock.
- T5: `S` waits for `E` to return (application-level, invisible to Postgres). `E` waits for `C`. `C` waits for `S`. No `deadlock_timeout` fires because the S→E edge is not a DB edge. No `lock_timeout` or `statement_timeout` is specified anywhere in the plan.
- Result: two connections leaked permanently; the buyer's cancel request never returns; and because the sweeper guard is "lượt trước chưa xong thì bỏ lượt này" (phase-05:184), **reservation expiry stops for the lifetime of the process**. Every subsequent order's stock is held forever.

**Evidence:**
- `phase-05-outbox-relay-scheduler.md:82-92` — claim + `gọi ExpireOrderUseCase` inside one `BEGIN…COMMIT`
- `phase-04-ordering-atomic-reservation.md:97-109` — expire/cancel flow opens its own `BEGIN … FOR UPDATE … COMMIT`
- `phase-04-ordering-atomic-reservation.md:239` — "toàn bộ trong `unitOfWork.withTransaction`"
- `phase-00-foundation-and-bedrock-spike.md:62-67` — `UnitOfWork` interface has no nesting/join/savepoint support
- Grep across `plans/**/*.md` for `lock_timeout|statement_timeout|deadlock|retry`: no timeout or retry policy exists.

**Suggested fix:** Decide the transaction boundary explicitly and write it in the phase:
(a) claim in its **own committed** transaction, then call `ExpireOrderUseCase` outside it; and
(b) extend `UnitOfWork` in Phase 00 with `withTransaction(fn, opts)` supporting an injected `Tx`
(join) or `SAVEPOINT`, and state in code-standards that a use case must never be invoked from
inside another transaction unless it accepts a `Tx`. Add `lock_timeout` + `statement_timeout` to the
pool config in Phase 00 so any residual cycle fails loudly instead of hanging.

---

## Finding 2: `releasing` is a state with no exit — reservations stuck there leak stock permanently

- **Severity:** Critical
- **Location:** Phase 05, "Reservation expiry job"; Phase 04, "Luồng huỷ / hết hạn"; Phase 04 schema

**Flaw:** The sweeper sets `status='releasing'`. `ExpireOrderUseCase` — the thing the sweeper then
calls — only iterates reservations **`status='held'`**. So even on the happy path the expire pass
finds zero reservations to release, marks the order `expired`, and returns success while the stock
is never returned. And nothing anywhere transitions `releasing` → `released`: the sweeper query
filters `status='held'` (so it never re-picks its own claims), the cancel/expire block filters
`status='held'`, and `fulfill` consumes `held`. Grep for recovery of `releasing` across all 13 plan
files returns only the three lines that create the state and the ADR bullet that praises it.

**Failure scenario:**
- T1: Order X (5 units) reaches `expires_at`.
- T2: Sweeper claims X's reservation → `status='releasing'`.
- T3: Sweeper calls `ExpireOrderUseCase(X)`. It reads "reservations of X with `status='held'`" → empty set. It skips the release block, sets `orders.status='expired'`, writes `outbox('order.expired')`, commits.
- T4: `inventory.reserved_qty` still contains 5. `available_qty` is still 5 short. The reservation row sits in `releasing` forever.
- T5: Nobody can recover it: the sweeper only scans `held`; cancel only releases `held`; the order is already `expired` so the idempotent guard short-circuits any retry (phase-04:100). The only repair is manual SQL, which the Phase 03 "ledger is mandatory" rule forbids.
- Test #6 (phase-05:147) would catch the happy path if written exactly as specified — but the plan's *design text* is what an implementer follows, and it is self-contradictory. Even with test #6 green, a process crash between T2 and T3 reproduces the identical permanent leak with **no** test covering it.

**Evidence:**
- `phase-05-outbox-relay-scheduler.md:84` — `SET status='releasing'`
- `phase-05-outbox-relay-scheduler.md:85-87` — re-scan filters `status='held'`
- `phase-04-ordering-atomic-reservation.md:102` — "cho từng reservation **status='held'** của đơn"
- `phase-04-ordering-atomic-reservation.md:149` — `check (status in ('held','releasing','released','consumed'))`
- `phase-05-outbox-relay-scheduler.md:94` — claims `releasing` is "cái chốt chống xử lý trùng" with no exit path described
- Grep across `plans/**/*.md` for `releasing|stuck|recover|reconcile|orphan`: 3 hits, all authoring the state, zero describing recovery.

**Suggested fix:** Either (a) drop `releasing` and claim with `UPDATE … SET status='released' … WHERE status='held' … RETURNING` as a single atomic statement — the same conditional-update pattern Phase 03/04 already established; or (b) keep `releasing` and add a mandatory reaper: a query that picks `status='releasing' AND updated_at < now() - interval '$stale'` and completes the release, plus a test "process dies after claim ⇒ next sweep recovers the reservation". Also make `ExpireOrderUseCase` accept `('held','releasing')`.

---

## Finding 3: Transaction isolation level, lock timeout, and serialization-failure retry are unspecified — the plan's central invariant is isolation-dependent and undefended

- **Severity:** Critical
- **Location:** Phase 00, "Architecture" (UnitOfWork); Phase 04, "Luồng tạo đơn"; `plan.md` acceptance criterion #1

**Flaw:** The whole "never oversell" claim rests on `UPDATE inventory SET available_qty = available_qty - $q … WHERE available_qty >= $q`. This is safe **only** under READ COMMITTED, where a blocked updater re-evaluates the `WHERE` clause against the newly committed row. Under REPEATABLE READ or SERIALIZABLE the same statement raises SQLSTATE `40001` (`could not serialize access due to concurrent update`) and the transaction must be **retried by the application**. The plan states the isolation level nowhere — grep across all 13 files for `isolation|read committed|repeatable read|serializ|40001|40P01|retry` returns zero relevant hits — and `UnitOfWork.withTransaction` has no isolation parameter, so the level is whatever `default_transaction_isolation` happens to be on that container. The plan also has no handler mapping `40001`/`40P01` to a retry or to a domain error, so any such failure surfaces as a 500 carrying a Postgres message — both a wrong-status bug and an internal-detail leak through the Phase 00 error envelope.

**Failure scenario:**
- T1: A future maintainer (or a managed-Postgres default, or a pooler init script) sets `default_transaction_isolation = 'repeatable read'` — a change that looks *safer*, and is exactly the kind of change the plan's silence invites.
- T2: 50 concurrent create-order requests hit a SKU with 10 units. Request A commits its conditional UPDATE.
- T3: Requests B…Z, whose snapshots predate A's commit, each raise `40001` instead of returning 0 rows.
- T4: Nothing catches `40001`. Each returns HTTP 500, not `INSUFFICIENT_STOCK`.
- T5: Acceptance criterion #1 ("đúng 10 thành công, 40 `INSUFFICIENT_STOCK`") fails — non-deterministically, depending on timing. Test #1 becomes the flaky test the plan spent two risk rows trying to prevent, and the invariant stops being trusted.

**Evidence:**
- `phase-03-inventory-core-ledger.md:97` — the conditional UPDATE, stated without an isolation level
- `phase-04-ordering-atomic-reservation.md:89` — "conditional UPDATE đã atomic trong một statement" (true only under READ COMMITTED)
- `phase-00-foundation-and-bedrock-spike.md:62-67` — `withTransaction` signature with no isolation option
- `plan.md:93` — acceptance criterion #1 demands exactly 40 `INSUFFICIENT_STOCK`
- Grep: no occurrence of `isolation`, `40001`, `SERIALIZABLE`, or any retry policy in any plan file.

**Suggested fix:** Pin `READ COMMITTED` explicitly in the `UnitOfWork` implementation (`BEGIN ISOLATION LEVEL READ COMMITTED`), state in ADR 0009 *why* the invariant holds under it and what breaks under REPEATABLE READ, add an assertion test that reads `current_setting('transaction_isolation')` inside a transaction, and add a `40001`/`40P01` bounded-retry wrapper in `withTransaction`.

---

## Finding 4: Batch-boundary split + order-level idempotency guard silently drops releases

- **Severity:** High
- **Location:** Phase 05, "Reservation expiry job"; Phase 04, "Luồng huỷ / hết hạn"

**Flaw:** The sweeper claims at **reservation** granularity (`LIMIT $batch`, `ORDER BY id`) then
groups by `order_id` and calls an **order**-granularity use case whose first act is an idempotency
guard on `orders.status`. An order whose reservations straddle the batch boundary (or are split
across two workers) is processed twice; the second call hits "status đã là cancelled/expired ⇒ trả
về nguyên trạng, KHÔNG lỗi" and returns success **without releasing the reservations in the second
batch**.

**Failure scenario:**
- Order X has 3 items → 3 reservations, ids 101, 102, 103. Batch size 2.
- T1: Sweep round 1 claims 101, 102. Groups → order X. Calls `ExpireOrderUseCase(X)`.
- T2: `ExpireOrderUseCase` sets `orders.X.status='expired'`, releases what it finds, commits.
- T3: Sweep round 2 claims 103. Groups → order X. Calls `ExpireOrderUseCase(X)`.
- T4: The guard sees `status='expired'` and returns "nguyên trạng, KHÔNG lỗi". Reservation 103 is never released; its quantity stays in `reserved_qty` forever.
- Same shape with two workers: `SKIP LOCKED` splits one order's reservations across sweepers by design.
- Test #8 (`expiry-concurrent`, 50 reservations, 2 sweepers) asserts only "no double-counting" — under-release passes it silently. Test #6 uses a single order that fits in one batch.

**Evidence:**
- `phase-05-outbox-relay-scheduler.md:87` — `ORDER BY id LIMIT $batch FOR UPDATE SKIP LOCKED`
- `phase-05-outbox-relay-scheduler.md:89-90` — "nhóm theo order_id → với mỗi order: gọi ExpireOrderUseCase"
- `phase-04-ordering-atomic-reservation.md:100` — idempotency guard keyed on order status, evaluated **before** the release block
- `phase-05-outbox-relay-scheduler.md:149` — test #8 asserts only "không bị cộng đúp" (no over-release), never "no under-release"

**Suggested fix:** Claim at order granularity (`SELECT DISTINCT order_id … FOR UPDATE SKIP LOCKED` over orders, then expire whole orders), or make the idempotency guard reservation-level so a re-entry still drains outstanding reservations. Add a test: order with N reservations, batch size N-1 ⇒ all N released.

---

## Finding 5: Payment callback vs expiry sweeper — a paid order can be left with unreleasable reservations

- **Severity:** High
- **Location:** Phase 06, "Quan hệ với đơn hàng" + `HandleCallbackUseCase`; Phase 05, "Reservation expiry job"; Phase 04, `FulfillOrderUseCase`

**Flaw:** The plan defends "sweeper must not expire a paid order" at two layers (query filter +
use-case guard) but never defines what happens to reservations the sweeper has **already claimed**
when the payment lands mid-sweep. There is no lock ordering between the payment path
(`OrderService.markPaid` → `orders`) and the sweep path (`inventory_reservations` → `orders`). The
guard fires *after* the state mutation it is supposed to protect.

**Failure scenario:**
- T1: Order X is `awaiting_payment`; `reservation_expires_at` has just passed.
- T2: Sweeper claims X's reservations → `status='releasing'` (phase-05:84).
- T3: Gateway callback for X arrives on another connection. `HandleCallbackUseCase` → `OrderService.markPaid` → `orders.X.status='paid'`, commits (phase-06:128-129).
- T4: Sweeper calls `ExpireOrderUseCase(X)`. The paid guard correctly refuses (phase-05:96). Nothing rolls back the `releasing` marks — they were set by a different statement and the plan describes no compensation.
- T5: Ops fulfils X. `FulfillOrderUseCase` consumes reservations with `status='held'` → finds none → `reserved_qty` is never decremented and the ledger records no `consume`. The goods ship; the books say 5 units are still reserved, forever.
- Worse variant: if fulfil calls `consumeAtomic` for the expected quantity anyway, it returns `null` (insufficient reserved) and **the plan never states what the use case does with `null` on the consume path** — undefined behaviour on the money-side flow.
- Test #8 in Phase 06 (`paid-order-not-cancellable`) is sequential: pay, *then* try to expire. It cannot reach this interleaving.

**Evidence:**
- `phase-06-payment-simulated.md:128` — callback + `markPaid` + outbox in one tx, no coordination with reservations
- `phase-05-outbox-relay-scheduler.md:84,96` — claim mutates reservation state before the paid guard runs
- `phase-04-ordering-atomic-reservation.md:24` — fulfil transitions `held → consumed` only
- `phase-06-payment-simulated.md:115` — test #8 is a sequential assertion, not a race
- `phase-03-inventory-core-ledger.md:93-95` — `reserveAtomic` returns `null` on shortfall; no `null` contract is stated for `consumeAtomic` anywhere

**Suggested fix:** Give the two paths one lock order — both must take `SELECT … FROM orders WHERE id=$1 FOR UPDATE` **first**, before touching `inventory_reservations`. That makes the paid guard authoritative because the sweeper cannot claim reservations of an order it has not locked. Add a test that commits `markPaid` between claim and expire and asserts reservations remain `held` and fulfil consumes exactly `quantity`.

---

## Finding 6: Four lock orders coexist on the same rows; the plan's deadlock argument covers only one pair

- **Severity:** High
- **Location:** Phase 04, "Vì sao sort theo `productId`" + test #3; Phase 05 claim SQL; Phase 03 "Hai cơ chế ghi"

**Flaw:** The plan proves deadlock-freedom for create-vs-create and stops there. Four different
orderings touch overlapping rows:
1. create-order: implicit locks on `inventory` in `product_id` order (phase-04:75)
2. cancel/expire: `orders` row first, then `inventory_reservations`/`inventory` in `product_id` order (phase-04:99-105)
3. sweeper: `inventory_reservations` in **`id`** order, then (via the use case) `orders` (phase-05:87-90)
4. adjust-stock: `SELECT … FOR UPDATE` on a single `inventory` row (phase-03:88) — a *different* mechanism on the same rows

Paths 2 and 3 acquire the same two resources in **opposite order** (`orders`→`reservations` vs
`reservations`→`orders`). That is a textbook cycle, and `SKIP LOCKED` does not prevent it: it only
skips rows already locked at claim time.

**Failure scenario:** the T1–T5 timeline in Finding 1 is exactly this cycle. If the sweeper is
refactored to run the expire in the *same* transaction (the obvious fix for Finding 1), the cycle
becomes a real Postgres deadlock: one side is killed with `40P01`, surfacing as an unexplained 500
on the buyer's cancel, or as a sweeper round that dies every cycle. Neither `40P01` handling nor a
retry is specified. Test #3 (`no-deadlock-crossing`) runs create-vs-create only, so it is green
while the real cycle ships. The plan itself leaves the release-side ordering open: "nếu vẫn gặp,
ghi lại và cân nhắc `ORDER BY` cả ở phía release" (phase-04:264) — deciding that *after* the bug
appears in production is the opposite of the plan's stated posture.

Secondary: the sort key is `product_id`, but the inventory row key is `(product_id, warehouse_id)`
and `reserveAtomic` takes a per-item `warehouseId` (phase-03:94) while `order_items` carries no
`warehouse_id` column (phase-04:133-140) — only `orders.warehouse_id` exists. Today that makes the
sort accidentally sufficient (one order = one warehouse) and the `warehouseId` parameter redundant;
the day multi-warehouse allocation is added, the sort key is silently wrong and nothing in the test
list notices.

**Evidence:**
- `phase-04-ordering-atomic-reservation.md:91` — deadlock rationale, create-vs-create only
- `phase-04-ordering-atomic-reservation.md:207` — test #3 covers only two create-order groups
- `phase-04-ordering-atomic-reservation.md:264` — release-side ordering explicitly deferred
- `phase-05-outbox-relay-scheduler.md:87` — `ORDER BY id`, a different global order
- `phase-03-inventory-core-ledger.md:86-89` — two mechanisms documented as intentional, with no lock-order rule connecting them
- `phase-04-ordering-atomic-reservation.md:120,133-140,147` — `warehouse_id` on `orders` and on `inventory_reservations` but not on `order_items`

**Suggested fix:** Write a single lock-order rule into `docs/code-standards.md` and ADR 0009:
*"any transaction touching both `orders` and inventory rows takes the `orders` row first; inventory
rows are always taken in `(product_id, warehouse_id)` ascending order."* Make the sweeper claim
orders, not reservations. Change test #3 to run create + cancel + sweeper concurrently and assert
zero `40P01` in the Postgres log.

---

## Finding 7: `attempts` is a claim counter, not a failure counter — crashes and restarts dead-letter events that were never delivered once

- **Severity:** High
- **Location:** Phase 05, "Relay loop" + migration 007

**Flaw:** The claim statement does `SET attempts = attempts + 1` and commits on its own, *before*
dispatch. So `attempts` counts *claims*, not *failures*. It does not set `next_attempt_at`, so a
claimed-but-undispatched event is immediately re-claimable on the very next poll tick (default 1s).
And `last_error` stays `NULL`, so an event that dies this way is invisible to the
`GET /ops/outbox?status=dead` screen's diagnosis. Separately, the claim `WHERE` clause filters on
`processed_at IS NULL AND attempts < $maxAttempts` while migration 007 introduces a parallel
`status` column with its own partial index — two representations of the same state, and the claim
SQL never reads or writes `status`, so the index `where status='pending'` will not even be used by
the query as written.

**Failure scenario:**
- T1: `OUTBOX_MAX_ATTEMPTS = 5`, poll interval 1s. A restart loop (deploy, OOM kill, Docker Desktop hiccup) cycles the API every few seconds.
- T2: Relay claims events 1–20: `attempts` 0→1, committed. Process dies before dispatch.
- T3: Restart. Same events re-claimed immediately (`next_attempt_at` was never set): `attempts` 1→2. Dies again.
- T4: After 5 restarts, all 20 events have `attempts = 5`, fall out of the claim predicate, and get marked `dead`. Audit rows for 20 orders are **permanently lost** with `last_error = NULL`, so nothing in the ops screen explains why.
- Acceptance criterion #6 ("relay at-least-once") is violated: these events were delivered **zero** times. No test covers it — test #3 exercises a handler that throws, which is the *other* counter.

**Evidence:**
- `phase-05-outbox-relay-scheduler.md:53-62` — claim increments `attempts` and returns, as its own statement
- `phase-05-outbox-relay-scheduler.md:64` — `next_attempt_at` is only set on the *failure* path, never at claim
- `phase-05-outbox-relay-scheduler.md:101-106` — `status` column + partial index added, never referenced by the claim SQL
- `phase-05-outbox-relay-scheduler.md:144` — test #3 exercises handler-throws only
- `plan.md:98` — acceptance criterion #6 claims at-least-once

**Suggested fix:** Separate the counters: a visibility timeout at claim time
(`next_attempt_at = now() + $visibilityTimeout`) versus a `failures` column incremented only on a
dispatch error. Only `failures >= maxAttempts` may dead-letter, and dead-lettering must require a
non-null `last_error`. Collapse `processed_at` and `status` into one source of truth. Add a test:
"claim, then kill the process before dispatch ⇒ event is delivered on the next run and `failures`
stays 0".

---

## Finding 8: The concurrency test design is flaky by construction, and its own anti-flake mitigation guts the invariant it proves

- **Severity:** High
- **Location:** `plan.md` acceptance criterion #1 + risk 7; Phase 00 test harness; Phase 04 risk table; Phase 03 risk table

**Flaw:** Three compounding problems.

1. **Shared container + `TRUNCATE` between tests + unconfigured runner parallelism.** Phase 00
   specifies "một container dùng chung cho cả suite, truncate giữa test". Vitest runs test **files**
   in parallel across workers by default. Grep across all 13 plan files for
   `worker|parallel|fileParallelism|singleThread|maxWorkers` returns zero configuration hits.
   Worker B truncating `inventory` mid-run of worker A's 50-request oversell test produces exactly
   the "10 successes" assertion failing at random — the flakiness the plan swore to avoid.
2. **Connection budget.** Phase 04 asks for "pool ≥ 60 connection", Phase 03 for ≥ 20, plus the
   app's own pool and each test file's admin client — against a `pgvector/pgvector:pg16` container
   whose default `max_connections` is 100. No `max_connections` tuning is mentioned. Exhaustion
   surfaces as `sorry, too many clients already` — a 500, not `INSUFFICIENT_STOCK`.
3. **The mitigation is worse than the disease.** Both risk rows say to "assert bằng **bất biến
   tổng** (`available+reserved` không đổi) thay vì thời điểm". That invariant is satisfied by a run
   in which **zero** requests succeed and all 50 fail with 500s — the sum is trivially unchanged
   because nothing happened. Applying that mitigation converts acceptance criterion #1 from a proof
   into a phantom test.

**Failure scenario:**
- T1: CI-local run, 8 Vitest workers. `ordering/no-oversell-concurrent.spec.ts` starts 50 in-flight requests.
- T2: `scheduler/expiry-concurrent.spec.ts` in another worker finishes and runs its `TRUNCATE inventory, inventory_reservations CASCADE`.
- T3: 23 of the 50 in-flight requests now fail with FK violations or find zero stock.
- T4: "đúng 10 thành công" fails. The developer reruns; it passes. The invariant becomes folklore — the plan's own named failure mode, "mất niềm tin vào chính bất biến quan trọng nhất".
- T5: The documented fix is applied — assert the sum instead of the counts — and the test stops proving anything at all.

**Evidence:**
- `phase-00-foundation-and-bedrock-spike.md:94,146` — shared container, truncate between tests, no runner isolation
- `phase-04-ordering-atomic-reservation.md:263` — "Pool ≥ 60 connection" and "assert bằng bất biến tổng … thay vì thời điểm"
- `phase-03-inventory-core-ledger.md:159` — same mitigation at "pool ≥ 20"
- `plan.md:93` — criterion #1 requires exact counts (10 / 40), incompatible with a sum-only assertion
- `plan.md:142` — risk 7 mitigates Windows flakiness with "retry policy rõ ràng", which for a concurrency invariant means retrying until green

**Suggested fix:** One Postgres **database per Vitest worker** (or `fileParallelism: false` for the
`*-concurrent.spec.ts` files), stated in Phase 00. Raise `max_connections` on the container
explicitly. Keep the exact-count assertions **and** add a third assertion that all 40 failures carry
error code `INSUFFICIENT_STOCK` — never a 500 — so serialization failures, deadlocks and pool
exhaustion fail the test loudly instead of hiding behind a sum that is invariant under total
failure.

---

## Finding 9: Phase 07 ports the consolidation marker rule without the compensating mechanism that makes it safe

- **Severity:** Medium
- **Location:** Phase 07, "Invariant 2 — gate bằng marker tiến" + test #7; `plan.md` risk 6

**Flaw:** The plan states "Marker tiến **trước** khi pass chạy ⇒ pass lỗi không bị thử lại mỗi lượt;
memory có thể muộn 1 pass chứ không mất." The "không mất" half is true in the original **only**
because the consolidation pass re-reads the **entire** transcript, not the slice since the marker:
`getMessages(sessionId)` is called with no limit, and the original's own comment says so ("a pass
re-reads the recent transcript, so the next one covers the same ground"). Phase 07 never states that
requirement. An implementer reading "progress marker" will naturally consolidate *messages since the
marker* — which is what a progress marker means everywhere else — and a failed pass then loses that
window permanently. Test #7 as specified asserts only that the pass is "không thử lại vô hạn ở lượt
sau"; it never asserts that the dropped window's facts eventually land in memory, so it cannot catch
the loss variant.

**Failure scenario:**
- T1: User states a fact in turn 5. `claimConsolidation` advances `consolidated_through` to message 10 and returns true.
- T2: The Bedrock call inside the pass times out (LiteLLM budget exhausted per `plan.md:141`, or a transient 429). The pass throws; the marker has already moved.
- T3: Turn 6 arrives. The implementation queries "messages where id > consolidated_through" → messages 11-12 only. Turn 5's fact is never seen by any pass again.
- T4: The fact is permanently absent from long-term memory while the transcript still shows the user stating it. Silent, unfalsifiable memory loss — the failure class Phase 07 flags as "rất khó phát hiện" for Invariant 1 but leaves open for Invariant 2.

Secondary contradiction: `plan.md:141` mitigates Bedrock cost with "cadence consolidation **thưa**"
(sparse cadence), while `phase-07:117` mandates "`CONSOLIDATE_AFTER_MESSAGES` **không được vượt 2**".
Those cannot both hold. With a full-transcript re-read every turn, extraction cost grows O(turns²)
per session, and the embedding cache does not help the extraction LLM calls at all.

**Evidence:**
- `phase-07-ai-harness-package.md:115` — the marker rule, stated without the full-transcript requirement
- `phase-07-ai-harness-package.md:167` — test #7 asserts non-retry, not eventual consolidation
- `AI-Harness-Clone/apps/api/src/session/session.controller.ts:218` — `getMessages(sessionId)` with no limit
- `AI-Harness-Clone/apps/api/src/session/session.controller.ts:199-200` — "the next pass re-reads the same transcript" is the stated justification
- `AI-Harness-Clone/apps/api/src/session/session.service.ts:116-119` — the original's comment tying marker-first to re-reading
- `AI-Harness-Clone/apps/api/src/session/session.service.ts:184-187` — `limit` is optional and omitted by the caller
- `plan.md:141` vs `phase-07-ai-harness-package.md:117` — cadence contradiction

**Suggested fix:** Add one sentence to Phase 07 §Invariant 2: *"the pass must re-read the full
transcript (or a window that provably overlaps the previous pass); the marker only gates whether a
pass runs, never what it reads."* Extend test #7: fail the pass, run one more turn, assert the fact
from the failed window is present in memory afterwards. Resolve the cadence contradiction in
`plan.md` explicitly (keep 2; control cost by capping transcript length instead).

---

## Finding 10: Three write paths rely on read-then-write guards with only sequential tests

- **Severity:** Medium
- **Location:** Phase 03 adjust-stock; Phase 04 `FulfillOrderUseCase`; Phase 08 `ApproveProposalUseCase`

**Flaw:** The plan is rigorous about atomic claims for reserve, idempotency keys and the outbox, then
leaves three writes on non-atomic guards, each with only a sequential test:

1. **adjust-stock creating a missing row.** Ported faithfully from Go, `SELECT … FOR UPDATE` on a
   `(product_id, warehouse_id)` pair that does not exist locks **nothing** — you cannot lock a row
   that is not there. Two concurrent adjusts for a new pair both see no rows and both INSERT against
   `unique (product_id, warehouse_id)` → one gets a raw `23505` surfaced as a 500, or, if
   `ON CONFLICT DO NOTHING` is used, one adjustment is silently lost **along with its mandatory
   ledger row**, breaking the Phase 03 guarantee "không có đường nào sửa tồn kho mà không để lại
   vết". Test #1 covers the create path sequentially; test #6 covers concurrency only on the reserve
   path, where the row already exists. The copilot's approve-proposal flow routes into exactly this
   path.
2. **Fulfil.** `phase-04:30` requires "Cancel/expire/**fulfill** gọi nhiều lần cho kết quả giống lần
   đầu", but the plan describes no order-row lock, no claim, and no idempotency guard for fulfil, and
   there is no `fulfill-twice` test (cancel/expire get test #9; fulfil gets only test #11,
   single-shot). Two concurrent fulfils both read reservations as `held` and both call
   `consumeAtomic` → `reserved_qty` decremented twice → the Phase 03 `check (reserved_qty >= 0)`
   safety net fires as a raw constraint error 500.
3. **Approve proposal.** `phase-08:184` says "guard idempotent theo `status`" — read status, then call
   `AdjustStockUseCase`. Test #11 approves twice **sequentially**. Two ops users clicking Approve on
   the same proposal (a realistic race — Phase 09 renders the button in the chat stream) both read
   `pending` and both apply the delta. The single write path the agent can reach has the weakest
   concurrency story in the plan.

Same family, smaller: `phase-03:97` shows the `RETURNING` clause as `available_qty + $q AS
before_available, …`. The reserved side has the **opposite** sign (`reserved_qty - $q AS
before_reserved`), and the Go ledger requires all four columns. The elided `…` sits exactly where a
copy-pasted `+ $q` produces a ledger that is internally consistent, passes test #5 if the assertion
is derived from the same wrong arithmetic, and corrupts every audit trail. Spell the full clause out.

**Evidence:**
- `StockFlow/module/inventory/storage/sql_inventory.go:24-36` — `SELECT … FOR UPDATE` with no row-creation guard
- `phase-03-inventory-core-ledger.md:20,88,119` — create-if-missing behaviour ported, tested sequentially only
- `phase-03-inventory-core-ledger.md:28` — "Mọi thay đổi `inventory` **bắt buộc** ghi một row sổ cái"
- `phase-04-ordering-atomic-reservation.md:30` vs `:221,241` — fulfil idempotency required, no mechanism, no test
- `phase-08-ops-copilot.md:167,184` — sequential double-approve test, status-based guard
- `StockFlow/module/inventory/storage/sql_inventory_transaction.go:27-30` and `module/inventory/model/inventory_transaction.go:17-20` — all four before/after columns are mandatory
- `phase-03-inventory-core-ledger.md:97` — `RETURNING` clause elided exactly at the sign flip

**Suggested fix:** Use `INSERT … ON CONFLICT (product_id, warehouse_id) DO UPDATE SET available_qty
= inventory.available_qty + $delta WHERE inventory.available_qty + $delta >= 0 RETURNING` for adjust
— one statement, no lock-a-nonexistent-row problem, before/after available from `RETURNING`. Give
fulfil the same `SELECT orders … FOR UPDATE` + status guard as cancel/expire, and add
`fulfill-twice-idempotent.spec.ts` and `approve-proposal-concurrent.spec.ts`. Make
`ApproveProposalUseCase` claim with `UPDATE stock_adjustment_proposals SET status='approved' …
WHERE id=$1 AND status='pending' RETURNING` and no-op on zero rows.

---

## Flow Trace Results

| Flow | Result |
|---|---|
| **Phase 04 create-order, 9 steps** | **PARTIAL.** Steps 1–9 are internally coherent and the conditional UPDATE does prevent oversell — but only under READ COMMITTED, which the plan never states (Finding 3). Rollback-undoes-prior-reserves holds because all steps share one transaction (`phase-04:86,93`). Query efficiency as claimed: pricing is one query, asserted by a query-count spy (`phase-02:141`); reserve is O(N) statements as declared. |
| **Phase 04 idempotency (steps 2 + 8, one tx)** | **PASSES, for a reason the plan does not state.** Concurrency safety comes from Postgres blocking the second `INSERT … ON CONFLICT DO NOTHING` until the first transaction resolves — not from the claim surviving a rollback. Unstated consequences: (a) request B blocks for the *entire* duration of A's transaction with no `lock_timeout`, so duplicate-key storms become pool exhaustion; (b) `idempotency_keys.status` (`phase-04:167`) can never be observed as `'in_progress'` by any other transaction, because it is set and overwritten inside one tx — a phantom column modelling a state that is unobservable by construction; (c) if A rolls back, B legitimately creates the order, so test #13's assertion "đúng một đơn được tạo" is satisfied by both correct and incorrect implementations. Under REPEATABLE READ, B's read of `response_snapshot` after A commits is not guaranteed — another dependency on Finding 3. |
| **Phase 03 → 04 handoff (`reserveAtomic`/`releaseAtomic`/`consumeAtomic`)** | **FAILED.** Only `reserveAtomic` has a stated signature (`phase-03:94-95`); `releaseAtomic` and `consumeAtomic` are named in `phase-03:134` and used in `phase-04:104,241` with no signature, no return contract, and no defined `null` handling — while `reserveAtomic`'s `null` is load-bearing. Fulfil's behaviour when `consumeAtomic` returns `null` is undefined (Findings 5, 10). Also `reserveAtomic(tx, productId, warehouseId, qty)` takes a per-item `warehouseId` that no per-item column supplies (`order_items` has none; only `orders.warehouse_id` exists). |
| **Phase 05 outbox relay, crash after claim** | **FAILED.** Not lost — silently dead-lettered after `maxAttempts` claim cycles, with `last_error = NULL` and no backoff between re-claims (Finding 7). Violates acceptance criterion #6 at `plan.md:98`. |
| **Phase 05 expiry sweeper, death between `releasing` and `ExpireOrderUseCase`** | **FAILED.** No recovery path exists anywhere in the plan — and the stuck state is reached even *without* a crash, because `ExpireOrderUseCase` only releases `status='held'` (Finding 2). The sweeper as written also self-blocks across two connections with no timeout (Finding 1). |
| **Phase 06 callback vs Phase 05 expiry race** | **FAILED.** No lock ordering between `markPaid` and the sweeper's claim. The paid guard runs after the reservation state has already been mutated, leaving a paid order with unreleasable, unconsumable reservations (Finding 5). |
| **Phase 07 consolidation, marker-advances-first** | **FAILED as specified.** The rule is ported; the mechanism that makes it safe (full-transcript re-read, `session.controller.ts:218`) is not stated, and test #7 cannot detect the loss variant (Finding 9). |
| **Phase 09 refresh mutex ↔ Phase 01 refresh rotation** | **PASSES for the named case, incomplete for two others.** `phase-09:78` correctly identifies the cross-phase bug and test #2 covers 5 parallel 401s in one tab. Not covered: (a) **multiple tabs** — an in-memory mutex (`lib/auth-store.ts`, `phase-09:47`) is per-tab, so two tabs refreshing against the same `httpOnly` cookie trigger Phase 01 reuse detection and revoke the family (`phase-01:26`), logging the user out of both; the plan's mitigation (`phase-09:162`) names only the single-tab case. (b) **SSE reconnect** — the copilot stream (`phase-08:27`) is a long-lived connection whose auth is not described; on access-token expiry mid-stream, whether it refreshes through the same mutex or opens a bare reconnect is undefined, and e2e `auth-refresh.spec.ts` (`phase-09:125`) tests a plain request, not a stream. Recommend a cross-tab lock (`BroadcastChannel` or a refresh-in-flight flag in `localStorage`) and an explicit statement of SSE re-auth behaviour. |
| **Phase 02 pricing → Phase 04 step 3** | **PASSES.** One batched query asserted by a query-count spy (`phase-02:141`); server-side price with `price_list_item_id` audit column (`phase-04:139`); DTO omits `unit_price` (`phase-04:244`). Acceptance criterion #2 is provable as specified. |
| **Plan claims about the Go reference repo** | **VERIFIED.** `CreateOrder` never touches inventory (`sql_order_tx.go:13-56`); `generateOrderCode` uses `FLOOR(RANDOM()*1000000)` (`sql_order_tx.go:302-304`); adjust uses `SELECT … FOR UPDATE` then read-modify-write (`sql_inventory.go:24-36,145-152`); the ledger requires all four before/after columns (`sql_inventory_transaction.go:17-58`). One vestigial detail: `inventory.version` exists (`model/inventory.go:14`) but is **never** used as an optimistic-lock predicate in any Go query; the plan carries it forward (`phase-03:55,97`) and increments it without ever checking it, so a future reader will mistake a dead column for an optimistic lock. Delete it or justify it in ADR 0008. |

---

## Acceptance-criteria impact

| `plan.md` criterion | Status after this review |
|---|---|
| #1 Không oversell | **At risk** — Findings 3 and 8. Correct only under an unpinned isolation level; the test that proves it is flaky by construction and its anti-flake mitigation removes the proof. |
| #3 Release đúng & idempotent | **Broken as designed** — Findings 2, 4, 5. Three independent paths leave stock permanently held. |
| #6 Outbox at-least-once | **Broken as designed** — Finding 7. Crash-claim cycles deliver zero times. |
| #2, #4, #5, #7, #8 | No blocking defect found in the traced paths. |

## Unresolved questions for the planner

1. What isolation level does `withTransaction` use, and where is that asserted? (Blocks Finding 3 and the Phase 04 test design.)
2. Is the expiry sweeper allowed to call a Phase 04 use case at all, or should Phase 04 expose an `ExpireOrderUseCase(tx, orderId)` variant that joins an existing transaction? This decision changes the `UnitOfWork` contract in Phase 00 and must be made before Phase 00 ships.
3. `reservation_expires_at` default (open question 4 in `plan.md:149`) sets the width of the Finding 5 race window. A 15-minute default makes the payment/expiry collision routine, not a corner case.
4. Is multi-warehouse allocation per order item ever in scope? If yes, the `product_id` sort key and the missing `order_items.warehouse_id` column must be fixed now, not later.
