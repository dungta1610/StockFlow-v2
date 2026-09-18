# Phase 05 — Outbox Relay, Scheduler & Audit: Code Review

Date: 2026-09-19 · Reviewer: code-reviewer · Scope: all uncommitted changes (`git status`), 14 modified + 38 new files.

## Scope
- Files: `platform/outbox/*`, `platform/scheduler/*`, `modules/ordering/application/{outbox-bindings,reservation-expiry.job,idempotency-cleanup.job}.ts`, `modules/ordering/http/ops-outbox.controller.ts`, `modules/audit/**`, modified ordering ports/repos, `order-transition.use-cases.ts`, `actor.ts`, `env.schema.ts`, `app.module.ts`, `ordering.module.ts`, migration 007, contracts `outbox.ts`/`audit.ts`, ADR 0017–0019, 17 new spec files + 2 helpers.
- LOC: ~210 changed lines in existing files, ~1.5k new (src + tests + docs).
- Verification run by reviewer:
  - `pnpm typecheck`: pass (all 4 packages)
  - `pnpm lint`: clean
  - `vitest run test/outbox test/scheduler test/audit test/platform`: 26 files / 58 tests pass
  - `pnpm test`: **76 files / 398 tests pass**
  - **Empirical probe:** a throwaway spec in the session scratchpad (not in the repo) ran the real `OutboxRelay` against the testcontainers Postgres. Its results are cited as P1–P5 below.

## Overall Assessment
Structure, the `platform/`↔`modules/` boundary, the expiry sweep, and the audit read side are solid, and the tests are mostly non-vacuous. **The relay's failure path is broken under real Postgres semantics.** A handler whose SQL fails aborts the claiming transaction. The code then cannot record the failure: no savepoint, no separate transaction. Instead:
- the whole batch rolls back;
- `attempts` never increments, so the event can never go `dead`;
- the event blocks the head of the queue forever;
- in production, `void this.pollOnce()` turns the error into an unhandled rejection. On Node 24 that crashes the process.

ADR 0017 documents the opposite ("the failure bookkeeping commits even though the handler's own work did not"). The tests miss it because every failing handler throws a JS `Error`, never a SQL error. **Not ready to land until C1/C2 are fixed.**

---

## Critical Issues

### C1. A handler SQL error aborts the claim tx, so the failure is never recorded (poison pill, no dead-letter, head-of-line block)
- **Where:** `apps/api/src/platform/outbox/outbox.relay.ts:136-152` (dispatch loop, no SAVEPOINT), `:158-179` (`recordFailure` runs on the already-aborted tx).
- **Scenario (confirmed by probe P1/P2):** events `[ok, sqlFail, ok]`. The `sqlFail` handler runs `SELECT 1/0`, and the real `AuditLogHandler` does the same thing when it hits an FK violation. The `catch` calls `recordFailure`, whose UPDATE fails with `current transaction is aborted, commands ignored until end of transaction block`. That error escapes `claimAndDispatch`, `withTransaction` rolls back, and `pollOnce()` rejects. Probe result after 3 polls:
  - all three rows are still `pending`, `attempts=0`, `last_error=null`;
  - the first `ok` handler ran 3 times, all rolled back;
  - the second `ok` event was never reached.
  - `attempts` never increments, so `OUTBOX_MAX_ATTEMPTS` never triggers and the event never goes `dead`. Because the claim is `ORDER BY id`, this event heads every batch: **the entire outbox stops permanently.**
  - The same happens if the `UPDATE … processed` statement itself fails, or if `statement_timeout`/`lock_timeout` hits inside a handler.
- **Second face (probe P3):** a handler that writes and then throws a JS error has its partial writes **committed** together with the failure record. This breaks the interface doc's contract that "a handler's writes and 'this event is done' always commit together or not at all".
- **Spec violated:** "lỗi một event không hỏng event khác" (one event's failure must not break other events), AC#6, test #5's intent, and the Risk-table row "Head-of-line blocking". ADR 0017 §Decision bullet 4 is factually wrong.
- **Fix:** give each event a savepoint, and roll back to it before recording the failure:
  ```ts
  for (const row of rows) {
    const event = toEvent(row);
    await tx.query('SAVEPOINT outbox_event');
    try {
      const handler = this.handlers.get(event.eventType);
      if (!handler) throw new Error(`No handler for "${event.eventType}"`); // see H2
      await handler.handle(tx, event);
      await tx.query(`UPDATE outbox_events SET status='processed', processed_at=now() WHERE id=$1`, [event.id]);
      await tx.query('RELEASE SAVEPOINT outbox_event');
      processed++;
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT outbox_event');
      failed++;
      if (await this.recordFailure(tx, event, err)) dead++;
    }
  }
  ```
  Add tests that would fail today:
  - (a) a handler running failing SQL in the middle of a batch: the other events end `processed`, the poison event has `attempts=1`;
  - (b) the same handler at `attempts = max-1`: it ends `dead`;
  - (c) a handler that INSERTs and then throws: the INSERT is rolled back.

  Then correct ADR 0017.

### C2. Relay timer swallows nothing: any DB error becomes an unhandled rejection, which crashes the API process
- **Where:** `outbox.relay.ts:101`, `setInterval(() => void this.pollOnce(), …)`. `pollOnce` has `try/finally` but no `catch`, and `main.ts` installs no `unhandledRejection` handler.
- **Scenario (confirmed by probe P4):** with a 50 ms interval and one C1-style poison event, the probe caught 6 unhandled rejections in 400 ms. On Node 24 the default `--unhandled-rejections=throw` kills the process. Two triggers in production:
  - any C1 poison event gives a crash loop on every instance;
  - so does any transient DB failure: a restart, a failover, `pool.connect` ECONNREFUSED, a COMMIT failure.
- `test/platform/database-resilience.spec.ts` exists precisely so the API survives a DB restart; the relay regresses that guarantee, and no test covers it because the relay never starts under `NODE_ENV=test`.
- By contrast, `SchedulerRunner.tick` does catch (`scheduler.runner.ts:29-33`); the relay should match it.
- **Fix:** use `setInterval(() => { this.pollOnce().catch((err) => this.logger.error(\`Outbox poll failed: ${(err as Error).message}\`)); }, …)`. Add a test that calls `start()` with a short interval and a failing claim (for example, a stopped pool or a poison event before the C1 fix), and asserts that no `unhandledRejection` fires.

---

## High Priority

### H1. The tests that should guard C1/C2 pass for the wrong reason
- `test/outbox/dead-event-does-not-block.spec.ts:10-15` and `retry-backoff.spec.ts` (`FailingHandler`) only throw JS errors, which never abort the tx. The "does not block" guarantee is therefore only proven for failures that don't touch the DB, and the realistic failure (a handler's SQL fails) is untested. See the C1 fix for the tests to add.

### H2. An event type with no handler is silently marked `processed` (lost, not dead)
- **Where:** `outbox.relay.ts:142-144`. Probe P5: an `order.refunded` event ends `processed` with `last_error=null`.
- **Scenario:**
  - A rolling deploy where an old instance lacks a new binding.
  - A future `order.*` type added to `OrderTransitions` without a projection entry (the state machine already declares `completed`/`awaiting_payment`).
  - Both give permanent, invisible loss. `processed` is global, not per-consumer, so the event is never re-delivered, and `GET /ops/outbox?status=dead` shows nothing.
- **Fix:** treat "no handler" as a failure (it goes through backoff to `dead` and shows up in `/ops/outbox?status=dead`), or leave the row `pending` with a warning. Don't mark it `processed`.

### H3. `registerHandler` silently overwrites an existing handler for the same event type
- **Where:** `outbox.relay.ts:89-91` (`Map.set`).
- **Scenario:** the success criterion is "a second handler = 1 file + 1 binding line". A second consumer declaring `order.created`, for example a notifications consumer, would **replace** `AuditLogHandler` with no error, and audit would silently stop being written. Fan-out is explicitly out of scope, so the relay should enforce that.
- **Fix:** `if (this.handlers.has(type)) throw new Error(\`Outbox event type "${type}" already has a handler\`)`, plus a unit test.

---

## Medium Priority

### M1. `audit_log.summary` keeps `total`, so unit price can be derived for single-line orders
- **Where:** `modules/audit/application/audit-log.handler.ts:32` (and ADR 0019 lists `total` as kept).
- The phase spec's keep-list is "trạng thái, mốc thời gian, số lượng" (status, timestamps, quantities); `total` is not on it. With `items[].quantity` also kept, `unit_price = total / quantity` for any one-line order, which makes the redaction ineffective for the commonest B2B case.
- Today only `ops_admin` reads it, and ops_admin already sees order prices, so the current exposure is nil. The risk is Phase 09 widening the readers, which is exactly the threat ADR 0019 was written for.
- **Options:** drop `total`, or keep it and record in ADR 0019 that audit readers are assumed to be allowed to see order totals. This is a product decision; flag it to the user rather than decide silently.

### M2. `GET /ops/outbox` has no test at all
- `ops-outbox.controller.ts` is a new authenticated endpoint. No spec asserts the `ops_admin`-only gate (ops → 403, buyer → 403), the `status` filter, or that the response omits `payload`.
- The payload omission is correct today (`present()` has no payload field, so no price leak), but nothing pins it. If someone adds `payload` to `OutboxEventView`, `unit_price` goes straight out.
- **Fix:** add `test/outbox/ops-outbox-endpoint.spec.ts` covering the role matrix, `?status=dead`, and `expect(body.data[0]).not.toHaveProperty('payload')`.

### M3. The idempotency cleanup can delete a live re-claimed key
- **Where:** `sql-idempotency.repository.ts:76`, `WHERE created_at < $1`.
- **Scenario:** `claim()` re-takes a `failed` key via `ON CONFLICT … DO UPDATE SET status='in_progress', updated_at=now()`, but it never resets `created_at`. So:
  1. A key created 25 h ago that failed is retried now.
  2. The hourly cleanup deletes it mid-flight.
  3. `complete()` throws "no longer held".
  4. The client gets a 500 on a legitimate request.
- Rare, but it contradicts the job's own doc comment ("stuck in_progress … removed once its TTL passes").
- **Fix:** `WHERE updated_at < $1`, or `created_at < $1 AND status <> 'in_progress' OR updated_at < $1`. Consider an index on the chosen column: today the hourly DELETE is a seq scan with no index.

### M4. The expiry sweep can starve behind persistently failing orders
- **Where:** `sql-order.repository.ts:177-178` (`ORDER BY id LIMIT $batch`), `reservation-expiry.job.ts:54-64`.
- **Scenario:** if ≥ `RESERVATION_SWEEP_BATCH` (50) expired orders fail every time (for example the "holds more than inventory has reserved" invariant throw, or chronic lock contention), every run re-selects the same 50 ids. Later orders never expire and their stock stays held. Nothing surfaces this beyond per-order error logs.
- **Fix (pick one):** order by `reservation_expires_at, id` and keep a per-run cursor (`id > lastSeen`), or loop batches until a batch returns fewer than `limit` ids or a time budget runs out.
- Also, the port doc says "soonest first" (`order.repository.ts` new method doc) but the SQL is `ORDER BY id`. Make them agree.

### M5. `crash-after-claim.spec.ts` never crashes the relay
- **Where:** `test/outbox/crash-after-claim.spec.ts:24-37`. The "crash" is a hand-written copy of the claim SQL followed by ROLLBACK on a separate client, so it proves Postgres row-lock semantics, not relay behavior.
- The follow-up `pollOnce` asserting `attempts: 0` does catch "claim increments attempts", so it is not fully vacuous.
- The claim SQL is also duplicated: if the relay's predicate drifts, this test keeps passing.
- **Fix:** crash the relay mid-dispatch. Use a handler that terminates its own backend (`SELECT pg_terminate_backend(pg_backend_pid())`) or a handler whose promise rejects after a connection kill, then assert `pending`, `attempts=0`, and that the next poll processes the event. With C1 fixed, this also exercises the real failure path.

### M6. The `audit_log.event_id` FK to `outbox_events` blocks any future outbox retention
- **Where:** `db/migrations/007_outbox_audit.sql:19`. `outbox_events` has no retention and grows forever, with `processed` rows kept indefinitely.
- The FK means a later cleanup job can't delete processed events without cascading into audit or dropping the FK, and ADR 0019 calls audit "rebuildable by replaying the outbox", which assumes the outbox is kept forever.
- `GET /ops/outbox?status=dead` has no index on `status='dead'`, so it seq-scans an ever-growing table.
- Not blocking for v1, but this is a schema decision that is cheap to change now (drop the FK, keep `UNIQUE`) and expensive after data exists. Record it in ADR 0017/0019 either way.

---

## Low Priority
- **L1.** The dead-letter window is very short. With base 200 ms doubling and max 8, an event goes `dead` after about 25 s of cumulative backoff (`outbox.relay.ts:33-38`). That is fine for deterministic in-process failures, but too aggressive once a failure can be transient (a DB blip, or the future external broker ADR 0017 advertises). Consider a larger base or cap.
- **L2.** The relay processes one batch per tick, so throughput is capped at `OUTBOX_BATCH_SIZE / OUTBOX_POLL_INTERVAL_MS`, about 20 events/s per instance by default. Re-poll immediately when `claimed === batchSize`.
- **L3.** `IdempotencyCleanupJob` first runs one hour after boot (`setInterval` only, `idempotency-cleanup.job.ts:38`). A process that restarts more often than hourly never cleans up. Run once shortly after bootstrap, with jitter.
- **L4.** Shutdown doesn't drain. `onApplicationShutdown` clears timers but doesn't await an in-flight `pollOnce`/`run()`. pg-pool `end()` waits for checked-out clients, so there's no hang and no data risk (rollback means redelivery). But a sweep mid-batch then logs one "Cannot use a pool after calling end" per remaining id. Track the in-flight promise and await it in `beforeApplicationShutdown`.
- **L5.** No test covers the production wiring (`onApplicationBootstrap` → `start()`/`schedule()`) because everything is gated on `NODE_ENV !== 'test'`. A typo in that gating would ship silently. Add one test that constructs the relay/job with `NODE_ENV: 'development'` via `configWithOverrides`, asserts a timer is registered, then calls the shutdown hook.
- **L6.** The `SYSTEM_ACTOR_ID` sentinel is compared in two places (`order-transition.use-cases.ts:85`, `audit-log.handler.ts:20-23`). The next FK-to-users column written from an actor will repeat the bug. Add `export const humanUserId = (a: Actor) => a.userId === SYSTEM_ACTOR_ID ? null : a.userId` in `identity/domain/actor.ts` and use it in both places. Also `Object.freeze` `systemActor` and its `roles` array (`actor.ts:50-55`): it is a shared ops_admin identity and any importer can mutate it today.
- **L7.** `relay-concurrent-claim.spec.ts:45-47` doesn't assert that both relays actually claimed something (`a > 0 && b > 0`). As written, it also passes if the relays happen to run serially.
- **L8.** `no-domain-import.spec.ts:30` only matches `/modules/` in specifiers. A future path alias such as `@modules/...` would bypass it; ESLint remains the primary gate. Acceptable.
- **L9.** `GET /ops/audit` with no filter under `all-buyers` scope sorts the whole table (`ORDER BY occurred_at DESC, id DESC`, no index on `occurred_at` alone). A filter on `aggregate_id` without `aggregate_type` can't use `idx_audit_aggregate`. Fine at v1 volumes.

---

## Explicit checklist (a)–(h)

**(a) Success criteria vs. code and a test that would fail if broken**

| Criterion | Met? | Evidence / gap |
|---|---|---|
| 16 tests green | Yes | 26 files / 58 tests in the targeted dirs; 398 in the full run |
| `platform/` doesn't import `modules/` (test #16 + ESLint) | Yes | grep-verified; spec has a scanner sanity case |
| Crash between claim and dispatch doesn't lose the event or bump `attempts` | Partly | Semantics hold (a rolled-back tx releases the lock). The test simulates the crash with hand-written SQL (M5). |
| 2 relays × 100 events, exactly once | Yes | Real `SKIP LOCKED`, exact-set assertion; no overlap assertion (L7) |
| 2 sweeps × 50 orders, no double release | Yes | Asserts stock, expired count, and release ledger count; would fail if every call errored (stock assertion) |
| 3-line order, batch 2 | Yes | Stronger than the spec: a third order provably untouched |
| Lock → 5 s timeout + log, no hang | Yes | Genuinely holds a conflicting `FOR UPDATE` from a second connection; asserts 3 s < t < 8 s and the log line |
| Paid order never expired | Yes | SQL filter plus `canTransition` |
| One "processed" column; claim predicate == index predicate | Yes | Claim `WHERE status='pending' AND (next_attempt_at IS NULL OR <= now())` is covered by partial index `WHERE status='pending'`. Test #7 checks state, not the predicate text (acceptable). |
| Summary has no unit price; audit read needs `ops_admin` + scope | Mostly | Key-level redaction is proven; `total` leaves the price derivable (M1). Scope is proven at repo level. |
| Second handler = 1 file + 1 line | Yes, with a caveat | Proven for distinct types; same-type registration silently overwrites (H3) |
| ADR 0017 states at-least-once, no ordering guarantee, broker path | Yes | But its failure-bookkeeping claim is false (C1) |
| Relay: one event's failure doesn't break others | **No** | C1/C2, probe P1–P4 |

**(b) No regression in ordering/inventory logic.** Walked every caller of `OrderTransitions.apply` (Cancel/Expire/MarkPaid/Fulfill use cases via `OrderController`, and now `ReservationExpiryJob`). The `createdBy` change only alters behavior when `actor.userId === SYSTEM_ACTOR_ID`, which no JWT can carry. `inventory_transactions.created_by` is nullable (005:41). New repo methods (`listReservedExpiredIds`, `deleteExpired`, `listByStatus`) are additive with single callers. The outbox payload still carries the sentinel `actor_user_id`, which the audit handler maps to null. No regression found, and the full suite is green.

**(c) Relay under Postgres semantics.**
- Claim predicate matches the index: OK.
- `attempts` counts failures only: OK for JS errors, **broken for SQL errors (C1)**.
- Handler throwing inside the claim tx: no savepoint and no separate tx, so the failure is lost (C1).
- Dead-letter and backoff: logic is correct but unreachable for SQL failures; window is short (L1).
- Overlap guard: correct per instance.
- Graceful shutdown: interval cleared, timers `unref`'d; no hang, no drain (L4). **Unhandled rejection on the timer path (C2).**

**(d) Scheduler/relay in tests and duplicates.**
- Nothing starts under `NODE_ENV=test` (set in `test/setup.ts` before import).
- `OutboxModule`/`SchedulerModule` are static modules imported twice, so each runner has a single instance.
- `start()` has a timer guard, and `schedule()` throws on a duplicate job name.
- Manually constructed jobs/relays in specs never call bootstrap.
- OK.

**(e) Audit.**
- Whitelist per event type: OK.
- `org_id NOT NULL` + FK: OK.
- `@Roles('ops_admin')` at class level: OK (`RolesGuard` uses `getAllAndOverride([handler, class])`).
- `@CurrentScope()` goes into SQL: OK.
- `/ops/outbox` responses exclude `payload`, so no price leak today, but it is untested (M2).
- `total` derivability (M1).

**(f) `platform/` never imports `modules/`.** OK (grep, spec, and ESLint).

**(g) Public contracts.** Additive only: 2 new contract files, 6 env vars (all with defaults, in `.env.example`), 2 new GET endpoints, one additive migration. No existing response shape changed.

**(h) Tooling.** typecheck 0, lint 0, targeted 58/58, full 398/398.

## Edge Cases Found by Scout
- A handler SQL error or a statement/lock timeout inside the claim tx causes a whole-batch rollback, with `attempts` frozen (C1).
- A DB restart while the relay polls crashes the process (C2).
- Rolling deploys with mismatched bindings lose events silently (H2).
- A failed idempotency key re-claimed after the TTL is deleted mid-flight (M3).
- More persistently failing expired orders than the batch size starve the sweep (M4).
- Single-line order: `total / quantity = unit_price` in the audit summary (M1).

## Recommended Actions (priority order)
1. C1: per-event SAVEPOINT, plus SQL-error, partial-write, and dead-letter-via-SQL-error tests; correct ADR 0017 §Decision.
2. C2: `.catch` + log on the relay timer, plus a test that no unhandled rejection fires.
3. H2: unknown event type becomes a failure (or stays pending), never `processed`.
4. H3: throw on a duplicate event-type registration.
5. M2: ops-outbox endpoint spec (role matrix, filter, no `payload`).
6. M1: user decision on `total` in the audit summary; update ADR 0019 accordingly.
7. M3, M4, M5, M6; then the Lows at leisure.

## Metrics
- Type coverage: strict TS, `tsc --noEmit` clean. The one `as unknown as ConfigService` cast is test-only (`config-fixtures.ts:18`).
- Tests: 17 new spec files / 21 new tests; full suite 398/398.
- Lint issues: 0.

## Plan follow-ups (for lead; plan files not edited)
- Phase 05 tasks 1–11 are implemented. The success criterion "lỗi một event không hỏng event khác" (one event's failure must not break other events) and the Risk row "Head-of-line blocking" are **not met** until C1/C2 land.
- Keep the phase at `in-review`, not `done`.

## Unresolved Questions
1. M1: may audit readers (now ops_admin; Phase 09 timeline possibly wider) see order `total`? That decides whether `total` stays in the summary.
2. M6: is `outbox_events` intended to be retained forever (making audit rebuildable), or will it get retention? That decides whether to keep the `audit_log.event_id` FK.

Status: DONE_WITH_CONCERNS
Summary: Phase 05 is structurally sound, and typecheck, lint, and all 398 tests pass. But the relay's failure path is broken under Postgres semantics, which I confirmed by running the real relay: a handler SQL error aborts the claiming transaction, so the failure is never recorded, the event never goes dead, and it blocks the queue forever. On the timer path, `void pollOnce()` turns that (or any DB blip) into an unhandled rejection that crashes the process.
Concerns/Blockers: C1 (no savepoint) and C2 (unhandled rejection) must be fixed before landing. H2 (unknown event type silently `processed`) and H3 (duplicate handler overwrite) should land with them. M1 (`total` in audit summary) needs a user decision.

---

## Re-verification (2026-09-19, after the implementer's "Review fixes" pass)

### Checks run by reviewer
- `pnpm typecheck`: pass (all 4 packages).
- `pnpm lint`: clean.
- `vitest run test/outbox test/scheduler test/audit test/platform`: **32 files / 75 tests pass**.
- `pnpm test` (full): **82 files / 415 tests pass**.
- Probes: I re-ran them against the new relay with a scratch spec in the session scratchpad, run via `vitest run --dir <scratchpad>`. Nothing was written to the repo.

### 1. Probes P1–P5 against the new relay

| Probe | Before | Now | Verdict |
|---|---|---|---|
| P1: `SELECT 1/0` handler in the middle of a batch | whole batch rolled back, `attempts=0`, `pollOnce` rejects | `{claimed:3, processed:2, failed:1}`; both neighbours `processed`; poison has `attempts=1`, `last_error="division by zero"`, backoff set. Seeded to 7, next poll: `dead`, `attempts=8` | Fixed |
| P2: real `AuditLogHandler` FK violation | poll rejects, nothing recorded | `failed:1`, `attempts=1`, `last_error` names `audit_log_actor_user_id_fkey` | Fixed |
| P3: handler writes then throws (x5 in one tx, with ok events before and after) | partial write committed | victim row untouched (`last_error=null`); all 5 failures `attempts=1`; trailing ok event `processed` | Fixed. Also proves savepoint-name reuse across many failures in one tx works. |
| P4: timer path with a poison event, plus a relay whose `withTransaction` always rejects (dead pool) | 6 unhandled rejections in 400 ms | **0** | Fixed |
| P5: unknown event type `order.refunded` | silently `processed` | `pending`, `attempts=1`, `last_error` = "No outbox handler registered for event type order.refunded" | Fixed |

### 2. Savepoint correctness (`outbox.relay.ts`, `claimAndDispatch`)
- **RELEASE on success:** correct. It comes after both the handler and the `processed` UPDATE, so a failure of the UPDATE also rolls back the handler's writes.
- **ROLLBACK TO before `recordFailure`:** correct. It returns the tx to a healthy state, so the bookkeeping UPDATE succeeds (P1/P2).
- **Name reuse per event:** correct under Postgres semantics.
  - After `ROLLBACK TO`, the savepoint stays defined. The next `SAVEPOINT outbox_event` stacks a new one that shadows it, and `RELEASE`/`ROLLBACK TO` always target the most recent. P3 (5 consecutive failures in one tx) confirms it.
  - The claim's row locks were taken before any savepoint, so they belong to the parent tx and survive `ROLLBACK TO`. No other relay can grab a failed event mid-batch.
- **Escape paths:** if `ROLLBACK TO`/`recordFailure` itself throws (lost connection, `statement_timeout`), the whole batch rolls back and the timer `.catch` logs it. The result is redelivery, not loss. Acceptable.
- **New Low (L10):** each event that writes consumes a subtransaction XID. Released subtransactions still count toward Postgres's 64-entry per-backend subxid cache. Beyond ~64 per tx, the cache overflows and other backends take the `pg_subtrans` SLRU lookup path, which degrades performance on the primary and on replicas. The default `OUTBOX_BATCH_SIZE=20` is safe, but `env.schema.ts` allows any positive int. Suggest `.max(64)` on `OUTBOX_BATCH_SIZE`.

### 3. M4 keyset cursor (`reservation-expiry.job.ts:61-80`, `sql-order.repository.ts:180-198`)
**Verdict: it cannot skip an order forever in any realistic scenario.** The worst case is a delay of one "lap". The cursor resets to `null` whenever a run reads a short page, so every order is revisited at least once per lap. A permanent skip would require the sweep never to catch up with expirations, and a system in that state is overloaded whatever the design.

Scenarios checked:
- **An order whose `reservation_expires_at` is earlier than the cursor becomes eligible later.**
  - Eligibility is `status='reserved' AND expires_at < now`. Nothing in v1 moves an order back to `reserved`, and nothing rewrites `reservation_expires_at` after creation.
  - The cursor only ever takes values below the `before` (current time) of the run that set it.
  - A new order gets `expires_at = created + TTL`, which is after its creation time, so it always lands ahead of any cursor set before it was created.
  - **TTL changes don't matter.** A shorter TTL still puts new orders in the future, so ahead of the cursor.
- **Clock skew between instances.** An order lands behind a fast instance's cursor only if the skew exceeds the TTL (30 min). Even then, that instance's next reset (end of lap) picks it up. Not a permanent skip.
- **Multiple instances.** Each has an independent cursor and covers the whole set every lap. The cost is duplicate work: the second instance waits on the order lock, then gets an idempotent no-op. No skip.
- **Process restart.** The cursor starts `null` and the sweep begins from the top. Failing orders are retried sooner. Correct.
- **Retry cadence (behavior change, acceptable).** A persistently or transiently failing order (for example a lock timeout) is now retried once per lap instead of every run. Under a sustained backlog of >= `batch` expirations per interval, laps get long. That trade is inherent to "no starvation".
- **New Low (L11): millisecond vs microsecond precision can re-open the original starvation.**
  - The cursor stores `reservationExpiresAt` as a JS `Date`, which has millisecond precision. `timestamptz` has microseconds.
  - App-written values are exact to the millisecond, so production orders created through `CreateOrderUseCase` are unaffected.
  - But a value written by SQL has sub-millisecond digits, for example an operator's bulk `UPDATE orders SET reservation_expires_at = now() ...` to force-expire. For such values the truncated cursor sorts *before* the row it came from, so `(expires_at, id) > cursor` re-selects the same rows.
  - If >= `batch` such rows share one millisecond and all fail persistently, every run returns the same page: the M4 starvation is back.
  - Fix, any one of: make the column `timestamptz(3)`; compare with `date_trunc('milliseconds', reservation_expires_at)` on both sides; or carry the cursor's timestamp as the DB's own text value.
- **Pre-existing (not new):** `before = new Date()` uses the app clock, and `ExpireOrderUseCase` doesn't re-check `reservation_expires_at`. So an instance whose clock runs ahead expires orders early by the skew. Using `now()` in SQL would remove this. Low.

### 4. M3 (index + query)
- The query `DELETE FROM idempotency_keys WHERE updated_at < $1` is correct.
  - `claim()` (first claim and re-claim of a `failed` key), `complete()` and `release()` all set `updated_at = now()`, so a live re-claimed key is never deleted mid-flight.
  - A key stuck `in_progress` is still reaped once its `updated_at` passes the TTL.
  - The rewritten `idempotency-cleanup.spec.ts` covers both cases.
- The index `idx_idempotency_keys_updated_at ON idempotency_keys (updated_at)` makes the DELETE an index range scan. Correct. Two Lows:
  - **L12:** indexing a column that changes on every UPDATE disables HOT updates on this table. Each claim->complete becomes a non-HOT update that writes to both the PK and the new index, on the `POST /orders` hot path. The cost is modest. An alternative is to drop the index: the table is TTL-bounded and an hourly seq scan is cheap. A `BRIN (updated_at)` would also work.
  - **L13:** the index lives in `007_outbox_audit.sql`, whose header and the spec say "only `audit_log`". The migration hasn't been applied or committed yet, so this is acceptable, but add a header line naming the extra index so the file's own description stays true.

### 5. M5 note: unlistened `error` on checked-out `pg` clients
**Verdict: yes, this is a real production crash risk. It is pre-existing in `platform/database/unit-of-work.ts` (`withTransaction`), not introduced by Phase 05. But the always-on relay and sweep now keep transactions in flight at all times, so a database restart, failover, or `pg_terminate_backend` during any transaction can take the API process down.**

Evidence:
- **pg-pool 3.14.0** `index.js:344` removes the pool's `idleListener` from a client on checkout, and `:385` re-adds it on release. `pool.query()` (`:464`) attaches its own `once('error')`, but `withTransaction` uses `pool.connect()` and never attaches one.
- **pg 8.23.0** `client.js:204-222`: when the connection ends unexpectedly on a client that is not ending, the client emits `'error'` ("Connection terminated unexpectedly").
- **P6 (probe):** a `withTransaction` running `pg_sleep(3)`, killed from another connection. The transaction promise rejects correctly ("terminating connection due to administrator command"), **and 1 uncaught exception "Connection terminated unexpectedly" fires.** That is an EventEmitter `'error'` with no listener, which kills the process outside a test runner.

Fix (small, belongs in `platform/database`):
- In `withTransaction`, attach `client.on('error', onError)` right after `pool.connect()`, and remove it in `finally` before release.
- Pass the connection error to `client.release(err)` so pg-pool destroys the client rather than re-pooling it. pg-pool already drops clients with `_queryable === false`, so this second part is defense in depth.
- Add a test modeled on P6 that asserts no `uncaughtException`, as `database-resilience.spec.ts` already does for idle clients.

### Other fix items spot-checked
- **H3:** `registerHandler` checks all declared types before setting any of them (all-or-nothing), and the new spec covers the partial-collision case.
- **M1:** `total` removed with a clear comment. `redaction.spec.ts` now uses a single-line order and a two-decimal money-shape backstop. ADR 0019 updated.
- **M2:** `ops-outbox-endpoint.spec.ts` covers the role matrix, `?status=dead`, and the absence of `payload`.
- **M5 (test):** `crash-after-claim.spec.ts` now imports `OUTBOX_PENDING_PREDICATE`, so the claim SQL can't drift silently. The implementer's reason for not self-terminating the backend is valid; see section 5 above.
- **M6:** documented as known debt in ADR 0017/0019. No schema change, as instructed.
- **ADR 0017:** the savepoint mechanism is now described accurately.
- **L1–L9** from the first pass were not in scope for this fix pass and remain open (non-blocking).

### Commit decision
**OK to commit Phase 05.** C1, C2, H1–H3 and M1–M6 are fixed and verified: empirically by probe for every relay item, and by code and test reading for the rest. Typecheck, lint and the full suite are green.

The unlistened checked-out-client `error` (section 5) should be fixed **before any production deploy**, as a separate small `platform/database` change with its own test. It is pre-existing and outside Phase 05's diff, so it doesn't block this commit. L10–L13 are non-blocking follow-ups.

Status: DONE_WITH_CONCERNS
Summary: All Phase 05 review fixes verified. Probes P1–P5 now behave correctly against real Postgres, the savepoint logic is sound, the M4 cursor can't skip orders forever, and M3 is correct. Typecheck, lint, the four test dirs (32/75) and the full suite (82/415) pass. OK to commit.
Concerns/Blockers: Not a commit blocker, but fix before production. A lost connection on a checked-out pg client in `UnitOfWork.withTransaction` raises an unlistened `'error'` that crashes the process: pre-existing, confirmed by probe P6, and made more likely by the always-on relay and sweep. Lows: L10 (cap `OUTBOX_BATCH_SIZE` <= 64), L11 (cursor ms/us precision), L12 (the `updated_at` index defeats HOT updates), L13 (label the extra index in the 007 header).
