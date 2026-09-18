# 0019 — Audit log: owned, scoped and redacted

**Status:** accepted · 2026-09-19

## Context
An earlier design stored every outbox event's raw `payload` verbatim in an audit
table with a nullable `org_id` and no role check on reading it — meaning
`order.created`'s payload (which includes `unit_price` and `price_list_item_id`,
the most sensitive figures in this system) would sit in a table with no declared
tenant boundary and no access control, while phase 09's ops console is meant to
read it as a timeline.

## Decision
- **`audit_log.org_id` is `NOT NULL`**, a foreign key to `organizations`, mirroring
  `outbox_events.org_id NOT NULL` (its source). A projection that cannot be traced
  to a tenant is refused at insert time, not stored with a null owner.
- **`summary` is a whitelist the consumer builds, never the raw payload.** Each
  event type this handler recognises names its kept fields explicitly in
  `AuditLogHandler` (`modules/audit/application/audit-log.handler.ts`).
  `order.created`'s projection keeps `order_id`, `order_code`, `buyer_org_id`,
  `placed_by_user_id`, `warehouse_id`, `currency`, `reservation_expires_at`, and
  each line's `product_id`/`sku`/`quantity` — **`unit_price`, `price_list_item_id`
  and `total` are named here only to say they are left out.** The phase's keep-list
  is status, timestamps and quantities; no money amount, derived or direct. `total`
  was in an earlier draft and was removed: with per-line `quantity` already kept,
  a kept `total` would make `unit_price` recoverable by division on any
  single-line order — the commonest shape of a B2B order — which defeats the
  redaction for exactly the case it matters most. Adding a field to what audit
  keeps is a one-line change to a named projection function, never an accidental
  payload leak, but it is also a decision to re-examine each time, not a default.
- **`event_id UNIQUE` + `ON CONFLICT (event_id) DO NOTHING`** is the audit
  handler's idempotency: the outbox relay's at-least-once delivery can call
  `handle()` for the same event twice, and the second call writes nothing new.
  This is the pattern docs/code-standards.md asks every later `OutboxHandler` to
  copy.
- **`actor_user_id` is nullable and set to `NULL` for system-driven events.** The
  reservation-expiry sweep acts as `systemActor`, which is not a row in `users`; if
  the handler wrote its sentinel id into a column with a foreign key to `users`,
  every audit row the sweep produces would fail that constraint. The handler checks
  for the sentinel and stores no actor instead of a dangling id.
- **`GET /ops/audit` requires `ops_admin`** (not the wider `ops`) and takes the
  caller's `OrgScope` like every other commerce read — `orgScopeOf(actor)` for an
  internal ops user is `all-buyers`, so an ops_admin sees every buyer
  organisation's audit trail, never the internal organisation's own (there is
  none to see: only buyer-owned orders write these events).
- **`audit_log` has no `org_type` column.** Every row's `org_id` today is a buyer
  organisation because its only source, `outbox_events.org_id`, is always set from
  `order.buyerOrgId`. The scope filter (`modules/audit/infrastructure/sql-audit.repository.ts`)
  documents this invariant rather than joining back to `organizations` for a check
  that can never fail while it holds.

## Consequences
- `test/audit/redaction.spec.ts` places a real single-line order (so `total /
  quantity = unit_price` would hold exactly, if anything leaked) and asserts the
  resulting `summary` has none of `unit_price`, `price_list_item_id`, `total`,
  `subtotal` or `line_total` by key, and — as a generic backstop against a future
  field under a different name — no value anywhere in the tree shaped like a money
  amount (`Money.toString()`'s fixed two-decimal format).
- `test/audit/scope.spec.ts` checks the role gate (`ops_admin` in, `ops` and buyer
  both 403) over HTTP, and separately calls `SqlAuditRepository.list` directly with
  a `single` scope to prove `org_id` — not a guessed `aggregate_id` — is what gates
  a row: a buyer org scoped to its own id never sees another org's row even when it
  names that row's `aggregate_id` exactly.
- Rebuilding `audit_log` from scratch is replaying `outbox_events` through
  `AuditLogHandler` again; `ON CONFLICT DO NOTHING` makes that safe to run against
  a table that already has some of the rows. This assumes `outbox_events` is kept
  forever — see docs/adr/0017's "Known debt" section for what a future retention
  job on `outbox_events` would need to do first (`audit_log.event_id`'s foreign
  key blocks a naive `DELETE`).
