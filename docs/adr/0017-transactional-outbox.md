# 0017 — Transactional outbox: claim by row lock, attempts count failures

**Status:** accepted · 2026-09-19

## Context
Every order status change must both change the row and let the rest of the system
know it happened, and those two things must never disagree — a committed status
change with no event, or an event for a change that rolled back, both break every
consumer built on top of it. `outbox_events` (migration 006) is written in the same
transaction as the change it describes (docs/adr/0004's rule that a use case never
opens its own transaction makes this straightforward: the controller or job's one
transaction covers both). What phase 05 adds is the other half — a relay that reads
that table and delivers each event to its consumer, at least once, without two
relay instances delivering the same event twice and without one instance's crash
losing an event or double-charging its retry budget.

## Decision
- **Claim is a row lock**, not a status update: `SELECT … WHERE status = 'pending'
  AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY id LIMIT
  $batch FOR UPDATE SKIP LOCKED`, taken inside the same transaction that dispatches
  and marks the event. Two relay instances polling at once simply claim different
  rows; `SKIP LOCKED` means neither blocks on the other.
- **`attempts` counts failed dispatches, never claims.** If the process crashes
  between claim and dispatch, the transaction never commits, the row lock is
  released, and the event returns to `pending` with `attempts` unchanged — exactly
  as if it had never been claimed. Counting on claim would dead-letter events that
  were never actually given to a handler, which is a lost event with extra steps.
- **`status` is the only "has this been handled" predicate.** The claim query's
  `WHERE` and `idx_outbox_pending` (`WHERE status = 'pending'`) use the same
  condition on purpose, so there is exactly one place that decides what counts as
  pending.
- **A handler runs inside the claiming transaction, under its own `SAVEPOINT`.**
  Success releases the savepoint and marks the event `processed`, still inside the
  outer transaction. Failure — a thrown JS error, *or a real SQL error, which
  aborts every later statement on that connection until something rolls back* —
  runs `ROLLBACK TO SAVEPOINT` first, undoing only that event's handler, and *then*
  records `attempts`, `last_error` and the next backoff, inside the now-valid
  transaction. Without the savepoint, a handler's SQL error (a constraint
  violation, a lock/statement timeout) would abort the whole claiming transaction:
  the failure could never be recorded — the recording `UPDATE` would itself fail
  against an aborted transaction — the event's `attempts` would stay frozen forever,
  and, claimed first by `ORDER BY id`, it would block every event behind it,
  permanently. The savepoint is what makes "one event's failure does not break
  another" true under real Postgres semantics, not only for handlers that happen to
  fail with a plain JS `throw`. Past `OUTBOX_MAX_ATTEMPTS`, the event becomes `dead`
  and drops out of the claim predicate, so it stops blocking the events after it.
- **An event type with no registered handler is a failure, never a silent
  `processed`.** A rolling deploy where an old instance lacks a new binding, or a
  future event type nobody wired a consumer to yet, must not look like successful,
  permanent delivery — it goes through the same backoff and eventually `dead`,
  where `GET /ops/outbox?status=dead` surfaces it.
- **`registerHandler()` throws on a duplicate event type.** Fan-out (more than one
  handler per event type) is out of scope; a second binding for a type that already
  has one is almost always a copy-paste mistake that would otherwise silently
  replace the first handler with no error.
- **Handlers must be idempotent.** At-least-once means a handler can see the same
  event more than once (a retry, or a batch where the "mark processed" step itself
  failed after the handler had already run). `AuditLogHandler` is the pattern every
  later consumer should copy: a unique key on the write (`event_id`) plus
  `ON CONFLICT (event_id) DO NOTHING`.
- **No ordering guarantee across the whole queue.** `ORDER BY id` plus
  `SKIP LOCKED` keeps relative order *within* what one worker claims, but two
  workers claiming concurrently can dispatch out of id order relative to each
  other. No handler may assume a global order.
- **The routing table (which event type goes to which handler) lives in
  `modules/`, not `platform/`** (`OutboxBindings`, `modules/ordering`). The relay
  (`platform/outbox`) exposes `registerHandler()` and knows nothing about order
  events specifically — adding a second consumer is one new file plus one call to
  `registerHandler()`, never a change to the relay itself.

## The path to a real broker
`dispatch()` today calls `handler.handle(tx, event)` in-process. Moving to SQS,
SNS or Kafka later changes only what a "dispatch" does with an already-claimed
row — publish it, rather than call a handler directly — and does not touch the
domain code that writes `outbox_events`, or the claim/retry/dead-letter logic.
The seam is exactly the boundary between `claimAndDispatch` and the handler call.

## Known debt: no retention on `outbox_events`
`outbox_events` grows forever; `processed` and `dead` rows are never removed. Not
addressed in phase 05, and deliberately not fixed silently, because
`audit_log.event_id` has a foreign key to `outbox_events(id)` (migration 007) and
ADR 0019 documents `audit_log` as "rebuildable by replaying the outbox," which
assumes the outbox is kept forever. A later retention job cannot simply `DELETE`
old rows without first either archiving/dropping that FK (keeping `event_id
UNIQUE` for the idempotency check, but no longer a foreign key) or accepting that
audit is no longer replayable past the retention window. Cheap to decide now,
before any production data exists to migrate; expensive after. `GET
/ops/outbox?status=dead` also has no index on `status`, so it sequentially scans
the whole table — fine at v1 volumes, worth revisiting alongside retention.

## Consequences
- `test/outbox/*.spec.ts` cover: normal dispatch, two relays racing 100 events, a
  simulated crash between claim and dispatch, retry backoff and dead-lettering, a
  dead event not blocking the events after it, handler idempotency, the
  single-source-of-truth invariant (no `processed` row without `processed_at`, none
  left matching the pending predicate), **a real SQL error mid-batch (savepoint
  rollback, the poisoned event recorded as a failure, the others still processed),
  a handler that writes then throws (the write rolls back with the failure), an
  unregistered event type (recorded as a failure, never `processed`), a duplicate
  handler registration (throws), and the relay timer never turning a poll failure
  into an unhandled rejection**.
- `test/platform/no-domain-import.spec.ts` fails the build if `platform/outbox`
  ever imports `modules/` — the boundary a nested `platform/` job broke before
  (docs/code-standards.md).
