# pg checked-out client 'error' crash and expiry-sweep cursor precision — fix report

Date: 2026-09-19 · Author: fullstack-developer

## Scope
Fixed the two items from `plans/reports/from-code-reviewer-to-main-260919-0057-phase-05-outbox-review-report.md`, Re-verification section, items 3 and 5:
1. A checked-out `pg` client's unlistened `'error'` event crashes the process on connection loss mid-transaction.
2. The reservation-expiry sweep's keyset cursor loses microsecond precision, reopening the starvation bug it was built to prevent.

Both were done TDD: test written first, confirmed red (and, for item 1, confirmed the red run does not crash the vitest worker), fix applied, confirmed green.

## Files Modified
- `apps/api/src/platform/database/unit-of-work.ts` — `withTransaction` now attaches a `client.on('error', …)` listener for the whole checkout and calls `client.release(err)` on a connection error so pg-pool destroys the client instead of re-pooling it. (+16/-2 lines)
- `apps/api/src/modules/ordering/application/ports/order.repository.ts` — `ExpiryCursor.expiresAt` and `ExpiredReservation.reservationExpiresAt` changed from `Date` to `string` (Postgres's own `::text` output), with doc comments explaining why. No other port methods touched.
- `apps/api/src/modules/ordering/infrastructure/sql-order.repository.ts` — only `listReservedExpired`: selects `reservation_expires_at::text` instead of the raw column, so the cursor round-trips at full microsecond precision instead of being parsed into a millisecond-precision JS `Date`. The `list()` method and its filters (owned by the parallel agent) were not touched — I re-read the file immediately before each edit and confirmed no overlap.

New tests:
- `apps/api/test/platform/checked-out-client-error.spec.ts` — new file.
- `apps/api/test/scheduler/expiry-cursor-microsecond-precision.spec.ts` — new file.

`apps/api/src/modules/ordering/application/reservation-expiry.job.ts` needed no changes: it treats the cursor as an opaque value (`{ expiresAt, id }`) and never parses it, so the type change flowed through untouched.

## What was fixed and why

### 1. Checked-out client `'error'` crash
`pg-pool` (index.js ~344/385) only listens for a client's `'error'` event while the client is idle in the pool; it removes that listener on checkout and re-adds it on release. `UnitOfWork.withTransaction` used `pool.connect()` and never attached its own listener, so a connection lost while checked out (DB restart, failover, `pg_terminate_backend`) emitted `'error'` ("Connection terminated unexpectedly") with no listener — an uncaught exception outside a test runner.

Fix: attach `client.on('error', onError)` right after `pool.connect()`, covering the whole checkout (BEGIN through COMMIT/ROLLBACK). On error, log it and remember it; in `finally`, remove the listener and call `client.release(connectionError)` — pg-pool destroys a client released with an error instead of returning it to the pool. Only `UnitOfWork.withTransaction` checks out clients in `apps/api/src/platform/database/**`; grepped for `pool.connect(` across `apps/api/src` and only found this one call site (the outbox relay and the idle-pool `'error'` handler in `pool.ts` were already correct and untouched).

Test (`checked-out-client-error.spec.ts`): starts a real `withTransaction` running `pg_sleep(3)`, polls `pg_stat_activity` for that backend's pid (filtered by `application_name = 'stockflow-api'` so it never matches the test's own `withDb` connections), kills it with `pg_terminate_backend` from a second connection, and asserts: the `withTransaction` promise rejects; `process.on('uncaughtException', …)` captured nothing after a 300ms grace period; and a follow-up `withTransaction` still succeeds (proving the dead client was destroyed, not re-pooled).

Confirmed red: with the old code, the test failed with `expected [ …(1) ] to deeply equal []` — the captured exception was exactly `Error { message: 'Connection terminated unexpectedly' }`, i.e. the review's P6 finding reproduced verbatim. Importantly, because the test installs its own `uncaughtException` listener before triggering the failure, the vitest worker itself did not crash — the failure surfaced as a normal assertion failure, as the task asked.

### 2. Expiry-sweep cursor precision
`reservation-expiry.job.ts` carries a keyset cursor `(reservationExpiresAt, id)` between sweep runs so a persistently-failing order never blocks orders behind it. The old code read `reservation_expires_at` as a JS `Date` (millisecond precision) and fed it back as a query parameter next run. Postgres stores `timestamptz` to the microsecond. Parsing into a `Date` truncates (floors) the sub-millisecond digits; serializing that `Date` back to a query parameter re-attaches only millisecond precision. So for a row whose real value is e.g. `.123001` (123ms + 1µs), the cursor built from it becomes `.123000` — strictly *less than* the row's own real value. The next page's `WHERE (reservation_expires_at, id) > (cursor)` then re-matches that same row (and anything else sharing that millisecond) forever, because the timestamp half of the tuple comparison alone is already `>`. If ≥ `RESERVATION_SWEEP_BATCH` such rows exist and keep failing, every run reselects exactly the same page and nothing behind it is ever reached — the same starvation the cursor exists to prevent, reopened at microsecond granularity.

Fix: cast `reservation_expires_at::text` in the `SELECT`, carry it as a `string` through `ExpiredReservation`/`ExpiryCursor` (documented as an opaque, exact-precision token — never to be reparsed as a `Date`), and pass it straight back as the `$3::timestamptz` parameter. Postgres's own text output round-trips through `::text` → `::timestamptz` exactly, so the comparison is always exact regardless of sub-millisecond digits. `ORDER BY reservation_expires_at, id` was already on the real column and needed no change.

Test (`expiry-cursor-microsecond-precision.spec.ts`): creates 4 orders, sets 3 of them to the same millisecond via SQL (`.123001Z`, `.123002Z`, `.123003Z`) and a 4th ("healthy") to a later, still-expired timestamp. Sets `RESERVATION_SWEEP_BATCH = 3` (equal to the failing set) so the first page is exactly a full batch and the cursor never resets between runs. A flaky `ExpireOrderUseCase` wrapper always throws for the 3 failing ids. Runs the job twice and asserts the healthy order reaches `expired` on the second run.

Confirmed red: with the old code the test failed with `expected 'reserved' to be 'expired'` — the healthy order was never reached, exactly matching the theorized mechanism (run 2 kept reselecting the same 3 failing rows because their real values all compared `>` the millisecond-truncated cursor).

Both reverts were temporary and scoped: for item 2 I reverted only the specific hunks in `order.repository.ts` and `sql-order.repository.ts` (re-reading each file immediately before reverting and again before restoring, to guard against the parallel agent's concurrent edits to the same files), ran the test, then restored the fix. `reservation-expiry.job.ts` was never touched by the revert since it needed no source change either way.

## Tests Status
- `pnpm typecheck`: pass, all 4 packages. (One transient error appeared first — `order.controller.ts` referencing `expires_within_minutes`, which doesn't exist on the stale `packages/contracts/dist` — caused by the parallel agent's in-flight edit to `packages/contracts/src/ordering.ts` not yet rebuilt. I ran `pnpm --filter @stockflow/contracts build` to refresh the gitignored `dist/` build artifact — no source files touched — and typecheck then passed cleanly. This is the parallel agent's own in-progress work, not something I fixed or need to fix.)
- `pnpm lint`: clean, no issues.
- New tests: both confirmed red before the fix, green after.
- `test/platform` + `test/scheduler` targeted run: 20 files / 51 tests pass.
- Full `pnpm test`: **85 files / 422 tests pass** (exceeds the ~415+ expected; the parallel agent's own new tests, e.g. `test/ordering/reservations-filter.spec.ts`, are included and passing too).
- Did not commit, per instructions.

## Issues Encountered
None blocking. The one typecheck hiccup (stale `contracts/dist`) was resolved by rebuilding a gitignored artifact, not by editing any source file — confirmed via `git check-ignore` and `git status` that `packages/contracts/dist` is untracked before and after.

No file-ownership conflicts: `order.controller.ts`, `packages/contracts/src/ordering.ts`, `order.repository.ts`'s `list()` method, and everything under `apps/web/**` were left untouched, confirmed by diffing only my target files and re-reading `sql-order.repository.ts` before each edit.

## Next Steps
- Both fixes are ready to land alongside Phase 05. The reviewer's "before any production deploy" concern (checked-out client crash) and the newly-identified L11 (cursor precision) are now closed.
- No further action needed from this task; the parallel agent's order-list/filter work is unaffected and still in progress in the same files.

Status: DONE
Summary: Fixed both robustness bugs via TDD — `UnitOfWork.withTransaction` now attaches/removes an `'error'` listener per checkout and destroys (rather than re-pools) a client that errors mid-transaction; the expiry-sweep cursor now carries Postgres's exact `::text` timestamp instead of a millisecond-truncated `Date`, closing the reopened starvation path. Both new tests were verified red-then-green against real Postgres via testcontainers. Typecheck, lint, targeted tests (51/51), and the full suite (422/422) all pass; nothing committed.
Concerns: None. One unresolved question is out of my scope: the M1 audit-summary `total` product decision and the M6 outbox-retention question from the original review report are still open per that report's own "Unresolved Questions" section — unrelated to this task's two items.
