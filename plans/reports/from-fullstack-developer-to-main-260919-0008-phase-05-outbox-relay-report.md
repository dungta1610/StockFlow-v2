# Phase 05 — Outbox Relay, Scheduler & Audit: Implementation Report

Date: 2026-09-19 · Strict TDD · Docker/testcontainers available and used for final verification.

## Files created

**Migration**
- `db/migrations/007_outbox_audit.sql` — `audit_log` table only (as specified).

**`platform/outbox/`** (mechanism, no domain knowledge)
- `outbox-handler.interface.ts` — `OutboxEvent`, `OutboxHandler`.
- `outbox.relay.ts` — `OutboxRelay`: claim (`FOR UPDATE SKIP LOCKED`, same predicate as `idx_outbox_pending`), dispatch inside the claiming transaction, exponential backoff with jitter, `registerHandler()` for consumer wiring, `onApplicationBootstrap` starts polling only when `NODE_ENV !== 'test'`.
- `outbox.module.ts`.

**`platform/scheduler/`**
- `job.interface.ts` — `Job`.
- `scheduler.runner.ts` — `SchedulerRunner`: per-job interval timer with an overlap guard (skips a tick if the previous run of that job hasn't finished).
- `scheduler.module.ts`.

**`modules/ordering/application/`**
- `outbox-bindings.ts` — `OutboxBindings` (`OnModuleInit`): registers `AuditLogHandler` with `OutboxRelay.registerHandler()`. This is the "modules/ routes, platform/ doesn't know domain" seam (ADR 0017).
- `reservation-expiry.job.ts` — `ReservationExpiryJob`: reads expired ids via `UnitOfWork.db` (no transaction), then one `withTransaction` per order calling `ExpireOrderUseCase` as `systemActor`.
- `idempotency-cleanup.job.ts` — `IdempotencyCleanupJob`: deletes keys older than `IDEMPOTENCY_TTL_HOURS`. Runs hourly (hardcoded interval — no env var for this was listed in the phase spec's env var list, see Deviations).

**`modules/ordering/http/`**
- `ops-outbox.controller.ts` — `GET /ops/outbox?status=...`, `@Roles('ops_admin')`, scoped.

**`modules/audit/`** (4 files: 3 + module, as the task instructions anticipated)
- `application/audit-log.handler.ts` — `AuditLogHandler`: per-event-type whitelist projection (`order.created`, `order.paid`, `order.fulfilled`, `order.cancelled`, `order.expired`); `ON CONFLICT (event_id) DO NOTHING`.
- `infrastructure/sql-audit.repository.ts` — `SqlAuditRepository` (no port/interface — a projection, not a domain).
- `http/audit.controller.ts` — `GET /ops/audit`, `@Roles('ops_admin')`, scoped.
- `audit.module.ts`.

**ADRs**
- `docs/adr/0017-transactional-outbox.md`
- `docs/adr/0018-reservation-expiry-via-order-lock.md`
- `docs/adr/0019-audit-log-scoping-and-redaction.md`

**Contracts**
- `packages/contracts/src/outbox.ts`, `packages/contracts/src/audit.ts` (query schemas + response view types), exported from `index.ts`.

**Tests** (16 required + 2 extra, all new)
- `test/outbox/{relay-dispatches,relay-concurrent-claim,crash-after-claim,retry-backoff,dead-event-does-not-block,handler-idempotent,single-source-of-truth}.spec.ts`
- `test/scheduler/{expiry-releases-stock,expiry-releases-all-lines,expiry-skips-paid,expiry-concurrent,no-nested-transaction,idempotency-cleanup}.spec.ts`
- `test/audit/{redaction,scope}.spec.ts`
- `test/platform/no-domain-import.spec.ts`
- `test/helpers/{outbox-fixtures,config-fixtures}.ts`
- Extra (demonstrating a success criterion, not one of the 16): a second `it()` in `relay-dispatches.spec.ts` registering two independent handlers to show "a second consumer is one file + one call".

## Files modified

- `apps/api/src/app.module.ts` — wires `OutboxModule`, `SchedulerModule`, `AuditModule`.
- `apps/api/src/modules/identity/domain/actor.ts` — `SYSTEM_ACTOR_ID`, `systemActor`.
- `apps/api/src/modules/ordering/ordering.module.ts` — new providers/controllers/imports.
- `apps/api/src/modules/ordering/application/ports/{order,idempotency,outbox}.repository.ts` — new abstract methods (`listReservedExpiredIds`, `deleteExpired`, `listByStatus`).
- `apps/api/src/modules/ordering/infrastructure/sql-{order,idempotency,outbox}.repository.ts` — implementations.
- `apps/api/src/modules/ordering/application/use-cases/order-transition.use-cases.ts` — `settleStock` now passes `createdBy: null` when the actor is `systemActor` (see Deviations — a bug found and fixed during TDD).
- `apps/api/src/platform/config/env.schema.ts`, `.env.example` — 6 new env vars exactly as listed in the phase spec.
- `docs/code-standards.md` — new "§9 Outbox handlers" section (idempotency rule, routing lives in `modules/`).
- `packages/contracts/src/index.ts` — exports the two new files.

Nothing under `apps/web/**` or `pnpm-lock.yaml` was touched.

## Test results

- `pnpm --filter @stockflow/api typecheck` — pass.
- `pnpm --filter @stockflow/contracts typecheck` / `pnpm typecheck` (root, all 4 packages incl. `apps/web`) — pass.
- `pnpm lint` (root) — clean, including the two `no-restricted-imports` architecture rules.
- Full API suite: `pnpm test` inside `apps/api` — **76 files, 398 tests, all pass** (this includes every pre-existing Phase 00–04 test file — none regressed).
- The 16 required tests + 2 extra: **17 files, 21 tests, all pass** in isolation and as part of the full run.
- Concurrency tests #2 (`relay-concurrent-claim`) and #11 (`expiry-concurrent`) run 3 additional times back-to-back: all pass, no flakiness observed.

## Deviations from the phase spec, with reasons

1. **Found and fixed a real bug during TDD, not anticipated by the spec: `systemActor` and the ledger's foreign key.** `inventory_transactions.created_by` (migration 005) has `REFERENCES users(id)`. The sweep calling `StockMovementService.release()` as `systemActor` — whose `userId` is a sentinel, not a real row — violated that FK on every release, so orders never actually expired (silently: the job's own per-order `catch` swallowed the error and logged it, exactly as designed for one bad order not blocking the batch — but *every* order hit it). Two fixes were considered:
   - Insert a real "system" user row via migration. Rejected: this test harness truncates every table in `commerce` (including `users`) before every single test (`test/setup.ts`, ADR 0006), so a migration-seeded row does not survive past the first test and the bug would resurface under test even though it would have worked in production.
   - **Chosen:** `OrderTransitions.settleStock` now passes `createdBy: null` (not `actor.userId`) when the actor is `systemActor`, mirroring the same "null, not a dangling id" decision already made for `audit_log.actor_user_id` (ADR 0019). This needed a small edit to `order-transition.use-cases.ts`, which is inside `apps/api/src/modules/ordering/**` (granted) but wasn't explicitly named in the task's parenthetical ("new job files, outbox-bindings, ops-outbox controller, module wiring"); I judged it in-scope since it's the direct integration point for `systemActor`, a type introduced by this phase, and reverting it would leave the sweep permanently broken.

2. **`process.env` overrides in a test file's `beforeAll` do not reach `ConfigService`.** `NestConfigModule.forRoot()` validates `process.env` **synchronously the first time** `platform/config/config.module.ts` is imported (it's called inside the `@Module({...})` decorator's argument expression, which Node/ESM module caching evaluates exactly once per process). Since `vitest.config.ts` runs the whole suite in a single forked process (`singleFork: true`, `fileParallelism: false` — ADR 0006), whichever test file first imports `AppModule` freezes the validated env for the rest of the run; a later file's `process.env.OUTBOX_MAX_ATTEMPTS = '3'` before its own `createTestApp()` call is silently ignored. I discovered this via a failing `retry-backoff.spec.ts` and confirmed it by instrumentation (see commit history of this session — not persisted, was throwaway debug files). Fix: added `test/helpers/config-fixtures.ts` (`configWithOverrides`) and, for the three tests that needed a non-default value (`retry-backoff`, `expiry-releases-all-lines`, `expiry-concurrent`), construct the class under test manually (`new OutboxRelay(...)` / `new ReservationExpiryJob(...)`) with a wrapped `ConfigService` — the same "manual construction" pattern the spec already implies for simulating multiple relay/sweep instances. I did **not** touch `test/setup.ts` (outside my file ownership, and changing it risks every other suite). `expiry-releases-all-lines.spec.ts` and `expiry-concurrent.spec.ts` are consequently *stronger* than my first draft: the batch test now uses 3 orders with a real batch of 2 (one order provably untouched, in full, rather than a batch value that happened to equal the order count).

3. **`IDEMPOTENCY_TTL_HOURS`'s cleanup job has a hardcoded run interval (1 hour), not an env var.** The phase spec's env var list names 6 variables and does not include one for the cleanup job's own polling interval; I did not add a 7th. Documented in the job's own file comment.

4. **`modules/audit`'s read repository has no abstract port**, unlike ordering's repositories. This matches the phase spec's own framing ("gọn còn 3 file — nó là một projection, không phải một domain") and is noted in the class's doc comment.

5. Two of the 16 required tests ended up structurally different from my very first draft (see #2) but assert the same invariants named in the spec: #9 now proves the batch boundary with an untouched third order rather than an all-equal-2-orders scenario; #11 is unchanged in intent (uses the default batch, which already covers 50 orders, via an explicit override for robustness against the constant changing later).

## Verification of specific claims

- **Claim query and `idx_outbox_pending` share the same predicate** (`status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())`, index is `(status, next_attempt_at, id) WHERE status = 'pending'`) — asserted structurally by test #7 and by code review; no separate "second predicate" exists anywhere.
- **`attempts` counts failures only** — test #3 (crash after claim, rollback, `attempts` unchanged) and #4 (dead-lettering) both assert this directly.
- **No nested transactions** — `ReservationExpiryJob.run()` reads via `uow.db` (autocommit) then opens one `withTransaction` per order; `test/scheduler/no-nested-transaction.spec.ts` holds a lock from a second raw connection and confirms the job returns within `lock_timeout` (~5.3s observed, asserted between 3s and 8s), logs the failure (`Logger.prototype.error` spy), and leaves the order `reserved`.
- **`platform/` never imports `modules/`** — enforced by both ESLint (`no-restricted-imports`, pre-existing rule, still passes) and the new `test/platform/no-domain-import.spec.ts`, which scans `platform/`'s source for any import specifier containing `/modules/`.
- **Redaction** — `test/audit/redaction.spec.ts` places a real priced order (base price `1234.50`) and asserts the resulting `audit_log.summary` tree contains neither the `unit_price` nor `price_list_item_id` key at any depth.

## Open questions / unresolved

None blocking. One judgment call worth flagging explicitly: fixing `order-transition.use-cases.ts` (item 1 above) was necessary for correctness — without it the reservation-expiry sweep is silently a no-op in both production and test — but it's a file outside the task's literal parenthetical list for `modules/ordering/**`. Happy to discuss if a narrower fix (e.g., a real system user seeded outside migrations) is preferred instead.

Status: DONE
Summary: All 16 required tests plus 2 extra pass; full existing 398-test suite (76 files) is green; typecheck and lint clean across the whole monorepo; concurrency tests re-run 3x with no flakiness. Found and fixed one real bug (systemActor vs. the ledger's `created_by` FK) that would have silently broken the reservation-expiry sweep.
Concerns/Blockers: One deliberate scope judgment call — modified `order-transition.use-cases.ts` (necessary bug fix, see Deviations #1) though it wasn't in the task's explicit parenthetical for `modules/ordering/**`.

---

## Review fixes (2026-09-19, second pass)

Code review (`plans/reports/from-code-reviewer-to-main-260919-0057-phase-05-outbox-review-report.md`) found the relay's failure path broken under real Postgres semantics: a handler SQL error aborted the claiming transaction, so the failure could never be recorded, the event never went `dead`, and it blocked the queue forever; on the timer path this also became an unhandled rejection. Fixed all Critical/High/Medium findings below, TDD (failing test written and confirmed red before each fix, except M2 which only needed coverage — see its row).

### C1 — handler SQL error aborted the claim tx, losing the failure
**Fix:** `outbox.relay.ts`'s `claimAndDispatch` now wraps each event in `SAVEPOINT outbox_event` / `RELEASE SAVEPOINT` on success / `ROLLBACK TO SAVEPOINT` before `recordFailure` on any error — a thrown JS error or a real aborted-transaction SQL error alike. Also folds H2 into the same try block (no handler ⇒ `throw`, same failure path).
**Tests (all written first, confirmed failing against the old code, then green):** `test/outbox/handler-sql-failure.spec.ts` — (a) `SELECT 1/0` mid-batch: other events still `processed`, poisoned one `attempts: 1`, `last_error` matches `division by zero`; (b) same handler seeded at `attempts = max - 1` (via a fake `OUTBOX_MAX_ATTEMPTS: 2` override, not env — see the phase-05 report's existing note on `process.env` overrides not reaching a shared `ConfigService`) ⇒ `dead`; (c) a handler that `INSERT`s into `idempotency_keys` then throws a plain JS error ⇒ the insert is gone (checked from a separate connection so pool-connection reuse can't hide it) and the failure is still recorded.
**ADR 0017:** corrected the "A handler runs inside the claiming transaction" bullet, which previously implied the failure bookkeeping "just" commits — it now names the savepoint mechanism and states plainly what breaks without it (the exact bug found).

### C2 — timer path: `void this.pollOnce()` had no catch
**Fix:** `start()`'s `setInterval` callback now calls `.catch()` and logs, matching `SchedulerRunner.tick`.
**Test:** `test/outbox/timer-error-handling.spec.ts` — a `process.on('unhandledRejection', ...)` listener installed per test; (1) `start()` at a 25ms interval against a `SELECT 1/0` handler for ~300ms (several ticks) asserts zero unhandled rejections; (2) `start()` against a `UnitOfWork` stub whose `withTransaction` always rejects (simulating a dead pool / ECONNREFUSED) — same assertion. Both failed (9 and 5 unhandled rejections respectively) before the fix.

### H1 — tests only covered JS-throw failures, not real SQL failures
Covered by C1's new tests (SQL error, not JS throw, is what's exercised) — no separate action needed, as the review itself allowed.

### H2 — unknown event type silently marked `processed`
**Fix:** folded into C1 (see above): no handler now `throw`s inside the per-event try, going through the same savepoint-rollback + `recordFailure` path.
**Test:** `test/outbox/unknown-event-type.spec.ts` — an event with no registered handler: first poll ⇒ `pending`, `attempts: 1`, `last_error` matches `/no.*handler/i` and names the event type; seeded to `attempts: 7` ⇒ next poll ⇒ `dead`.

### H3 — `registerHandler` silently overwrote a duplicate type
**Fix:** `registerHandler` now checks every declared type against the existing map *before* setting any of them (all-or-nothing), throwing `Outbox event type "..." already has a handler registered.` on any collision.
**Test:** `test/outbox/duplicate-handler-registration.spec.ts` — three cases: a second distinct handler for an already-bound type throws; registering the *same* handler instance twice throws; a handler declaring two types where only the second collides throws and leaves the first type (`type.a`) unbound too (verified by dispatching an event of that type and observing the "no handler" failure path, not `processed`).
**Fixed a real collateral break:** `retry-backoff.spec.ts` registered a fresh `FailingHandler` for the same type in two separate `it()`s against one shared relay — this now throws under H3. Moved registration into `beforeAll` (the handler is stateless "always fails" regardless of which test uses it).

### M1 — `total` in `audit_log.summary` made unit price derivable
**Fix:** `AuditLogHandler`'s `orderCreated` projection no longer includes `total`. Per the coordinator's explicit instruction this was decided as "drop `total` (and any other derived money)", not left as an open question.
**Test:** `test/audit/redaction.spec.ts` rewritten to (a) use a single-line order (quantity 1, where `total / quantity = unit_price` exactly — the sharpest version of the threat), (b) assert absence of `total`/`subtotal`/`line_total` keys in addition to the existing `unit_price`/`price_list_item_id` checks, and (c) a generic backstop: collect every primitive value in the summary tree and assert none match `Money.toString()`'s fixed two-decimal shape (`/^\d+\.\d{2}$/`) — this would catch a future money field under any name, not only ones this handler's authors thought to name. **ADR 0019** updated to state the decision and reasoning.

### M2 — no test for `GET /ops/outbox`
**Fix:** none needed (the endpoint was already correct — payload already omitted). **Test added:** `test/outbox/ops-outbox-endpoint.spec.ts` — role matrix (`ops_admin` 200, `ops` 403, `buyer` 403), `?status=dead` filter (with a genuinely mixed pending/dead fixture), `not.toHaveProperty('payload')` on every returned row after placing a real priced order, and an org-scope sanity check. This is the one fix item where the test passed immediately (4/4 green on first run) since there was no bug to reproduce — matches the review's own framing ("the payload omission is correct today... but nothing pins it").

### M3 — cleanup could delete a live re-claimed idempotency key
**Fix:** `SqlIdempotencyRepository.deleteExpired` now deletes `WHERE updated_at < $1` instead of `created_at < $1`. `claim()` already sets `updated_at = now()` on both first claim and re-claim of a `failed` key, so this is the one column that means "since when has this row been in its current state" for every status. Added `idx_idempotency_keys_updated_at` to migration 007 (the DELETE was previously an unindexed seq scan; the review flagged this explicitly under M3).
**Test:** `test/scheduler/idempotency-cleanup.spec.ts` rewritten with a `KeyRow` fixture parameterised by status/createdHoursAgo/updatedHoursAgo, covering: a completed key past TTL is deleted; one within TTL is kept (both as before); **new:** a key created 25h ago then re-claimed (`status: 'in_progress'`, `updated_at: now()`) is *not* deleted mid-flight; a key genuinely stuck `in_progress` for 100h (a crashed worker, `updated_at` never advanced) is still deleted once its own TTL passes, matching the job's original doc comment.

### M4 — sweep could starve behind persistently failing orders
**Fix (keyset cursor across runs — the "simplest correct" option, since page-until-short would silently break the existing, review-accepted `expiry-releases-all-lines.spec.ts` batch semantics — see reasoning below):**
- `OrderRepository.listReservedExpiredIds(db, before, limit)` → `listReservedExpired(db, before, limit, after?)`, returning `{id, reservationExpiresAt}[]`, ordered `ORDER BY reservation_expires_at, id` (soonest-first, now matching the port doc comment, which the review flagged as disagreeing with the old `ORDER BY id`). `after` is a `(expiresAt, id)` row-comparison keyset cursor (`(reservation_expires_at, id) > ($cursor_expires_at, $cursor_id)`).
- `ReservationExpiryJob` keeps `cursor: ExpiryCursor | null` as instance state, advancing it after *every* order it attempts (in a `finally`, so both success and failure advance it), and resetting to `null` only when a run reads fewer than a full batch (it reached the end of the currently-expired set).
- Considered and rejected the "loop pages within one run until a page is short" alternative: it would make a single `run()` call drain the *entire* backlog regardless of `RESERVATION_SWEEP_BATCH`, which breaks the already-reviewer-accepted `expiry-releases-all-lines.spec.ts` semantics ("3-line order, batch 2 — stronger than the spec: a third order provably untouched" per the review's own checklist). The cross-run cursor preserves "one run touches at most `batchSize` orders" while still guaranteeing forward progress across repeated scheduler ticks.
**Test:** `test/scheduler/expiry-avoids-starvation.spec.ts` — 3 orders, batch 2, a fake `ExpireOrderUseCase` substitute that always throws for two specific (soonest-expiring) order ids and delegates to the real use case otherwise. Run 1 (batch selects the two failing orders) leaves the third order untouched; run 2 (cursor resumes past the two failures) expires it. Failed as expected before the fix (asserted `'expired'`, got `'reserved'`). All 4 pre-existing scheduler tests re-verified green with no changes to their own assertions, confirming no regression to the batch-boundary or concurrent-sweep semantics.
**ADR 0018:** updated with the cursor mechanism and the corrected `ORDER BY`.

### M5 — `crash-after-claim.spec.ts` duplicated the claim SQL instead of exercising a real crash
**Investigated the suggested fix and rejected it — documented here rather than silently skipped.** Tried a handler calling `SELECT pg_terminate_backend(pg_backend_pid())` (self-terminating its own connection mid-dispatch) in a throwaway probe. Result: node-postgres emits the connection loss as an **`error` event directly on the `Client`/`Connection` object**, not only as the query promise's rejection — and nothing in this codebase (or `pg`'s pool) attaches a listener for that on a *checked-out* client (`pool.on('error')` only covers *idle* clients — see `pool.ts`'s own comment). With no listener, Node treats it as an uncaught exception; the probe reproduced this immediately (2 uncaught exceptions, one test run corrupted). Self-termination is therefore not usable here without either (a) accepting a real risk of crashing the test process, which is the opposite of what M5 asks for, or (b) adding a `client.on('error', ...)` listener somewhere in this codebase purely to make a test safe — out of scope for this review pass and worth its own decision, not a drive-by addition. Also worth flagging as a **possible latent production robustness gap**: if a connection genuinely dies mid-query outside `pollOnce`'s own error handling (a network blip while a checked-out client is mid-statement), the same unlistened `error` event could in principle crash the process the same way C2 did — I did not investigate further since it's outside this review's explicit scope, but flagging it for a follow-up look.
**What I did instead:** exported `OUTBOX_PENDING_PREDICATE` from `outbox.relay.ts` (the exact WHERE-clause fragment the real claim query uses) and had `crash-after-claim.spec.ts` import and reuse it instead of a hand-typed copy — directly addresses the review's "if the relay's predicate drifts, this test keeps passing" concern, without the flakiness risk. The test's semantics (claim via a second raw connection, `ROLLBACK`, assert `pending`/`attempts: 0`/`processed_at: null`, then a normal `pollOnce()` processes it) are unchanged.

### M6 — `audit_log.event_id` FK blocks future outbox retention
**Fix:** no schema change (as instructed — "do not implement outbox retention"). Added a "Known debt: no retention on `outbox_events`" section to ADR 0017 naming the FK, what a retention job would need to do first (archive/drop the FK, keep `event_id UNIQUE`, or accept audit is no longer replayable past the window), and the unindexed `status = 'dead'` filter. Cross-referenced from ADR 0019.

### Verification
- `pnpm typecheck` (root, all 4 packages incl. `apps/web`): pass.
- `pnpm lint` (root): clean (one `no-unused-vars` caught and fixed in `ops-outbox-endpoint.spec.ts` along the way).
- Four target dirs (`test/outbox test/scheduler test/audit test/platform`): **32 files / 75 tests, all pass.**
- Full suite `pnpm test`: **82 files / 415 tests, all pass** — up from 76/398 before this pass (17 new/rewritten test files, net +17 tests).
- Concurrency tests re-run 3x each: `relay-concurrent-claim.spec.ts`, `expiry-concurrent.spec.ts`, `expiry-avoids-starvation.spec.ts` — all green, no flakiness, consistent ~0.9–1.1s runtimes.

### New files
- `apps/api/test/outbox/{handler-sql-failure,timer-error-handling,unknown-event-type,duplicate-handler-registration,ops-outbox-endpoint}.spec.ts`
- `apps/api/test/scheduler/expiry-avoids-starvation.spec.ts`

### Modified files (this pass)
- `apps/api/src/platform/outbox/outbox.relay.ts` (C1, C2, H2, H3, exports `OUTBOX_PENDING_PREDICATE`)
- `apps/api/src/modules/audit/application/audit-log.handler.ts` (M1)
- `apps/api/src/modules/ordering/infrastructure/sql-idempotency.repository.ts` (M3)
- `apps/api/src/modules/ordering/application/ports/order.repository.ts`, `infrastructure/sql-order.repository.ts`, `application/reservation-expiry.job.ts` (M4)
- `apps/api/test/outbox/{retry-backoff,crash-after-claim}.spec.ts`, `apps/api/test/audit/redaction.spec.ts`, `apps/api/test/scheduler/idempotency-cleanup.spec.ts` (test rewrites for H3 compatibility, M5, M1, M3)
- `apps/api/test/helpers/outbox-fixtures.ts` (added `setOutboxEventAttempts`, `idempotencyKeyExists`, shared from the retry-backoff test's former local helper)
- `db/migrations/007_outbox_audit.sql` (M3 index)
- `docs/adr/0017-transactional-outbox.md`, `docs/adr/0018-reservation-expiry-via-order-lock.md`, `docs/adr/0019-audit-log-scoping-and-redaction.md`

No changes to `apps/web/**`, `pnpm-lock.yaml`, `docs/code-standards.md` (§9's existing wording already covered the idempotency rule and stayed accurate), or any contracts file (the endpoint shapes didn't change).

### Open questions
None blocking. The M5 investigation surfaced a possible latent gap (unlistened `error` events on checked-out `pg` clients could crash the process on a genuine mid-query connection loss, the same shape as C2 but not going through `pollOnce`'s own handling) — flagged above, not fixed, since it's outside this review's explicit scope and deserves its own look rather than a drive-by patch.

Status: DONE
Summary: All Critical (C1, C2), High (H1, H2, H3) and Medium (M1–M6) findings from the review addressed with TDD (failing test confirmed red, then fixed, for every item except M2 which needed only coverage). Full suite 82 files / 415 tests green, typecheck and lint clean monorepo-wide, target-dir and concurrency re-runs all stable across repeats.
Concerns/Blockers: None blocking. M5 was investigated and the suggested fix (self-terminating backend) was found to reliably crash the test process via an unlistened `pg` Client `error` event — used a lower-risk fix (shared predicate constant) instead and documented why, including a possible related production robustness gap worth a follow-up look. M1's resolution (drop `total`) was pre-decided by the coordinator, not re-litigated.
