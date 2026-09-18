# Phase 11 hardening: EXPLAIN sweep, error-code consistency, dead code

Plan: `plans/260916-2327-stockflow-v2-b2b-nestjs-ai-harness/phase-11-docs-diagrams-hardening.md` §Implementation Steps step 1 (EXPLAIN + error codes) plus the dead-code bullet. Date 2026-09-19.

## 1. EXPLAIN sweep

### Setup (throwaway, never touched `stockflow-v2-*`)

- Started a standalone container `sf-explain-scratch` (`pgvector/pgvector:0.8.1-pg16`, port 55440), separate from the running compose stack and from testcontainers used by the test suite (which was running `no-oversell-concurrent` in a loop the whole time — untouched).
- Ran migrations 001–007 against it with `scripts/migrate.ts` (`DATABASE_URL` pointed at the scratch container, `MIGRATIONS_DIR=db/migrations`).
- Seeded with raw SQL (`generate_series` + array-index random picks, no ORM): 601 organisations, 3,050 users, 3,000 products, 25 warehouses, 75,000 inventory rows (full product×warehouse), 501 price lists / 4,509 items, **100,000 orders**, 100,000 order_items, **200,000 inventory_transactions**, **120,000 outbox_events**, **100,104 audit_log** rows (audit derived 1:1 from `processed` outbox events, guaranteeing valid FKs). `ANALYZE` run after seeding.
- Ran `EXPLAIN (ANALYZE, BUFFERS)` via a Node script using `pg`'s `Client.query(text, values)` — the extended protocol, unnamed statement, so Postgres plans against the actual bound values exactly the way node-pg/the app's `Tx.query()` sends them (not literal-substituted SQL).
- Covered every filter combination the HTTP layer's Zod query schemas allow, for all 9 named list endpoints (orders, inventories, inventory transactions, products, warehouses, price lists, organisations, users, audit log) plus `ops/outbox`.
- Torn down: `docker rm -f sf-explain-scratch`. Compose stack (`stockflow-v2-postgres-1` etc.) confirmed still `Up ... (healthy)` throughout and after.

### Findings

Every filter combination on **orders** was already well served by existing indexes (`idx_orders_buyer_created`, `idx_orders_created`, `idx_orders_reserved_expiry`, the `order_code` unique index) — buyer-scoped, status, warehouse_id, and the reservations-screen query all resolved in <1ms with small buffer counts. No change needed there; the extensive existing code comment in `sql-order.repository.ts` about the reserved-expiry index already reflects real EXPLAIN work.

Two tables had **no index at all** covering their default sort column, so any list call that didn't happen to hit one of the narrow per-FK indexes forced a full scan + in-memory sort of the whole table:

| Query | Before | After |
|---|---|---|
| `audit_log`, no filter (ops browsing, scope=all-buyers→`TRUE`) | Parallel Seq Scan, 100k rows, **1658 buffers, 9.7ms** | Index Only Scan, **4 buffers, 0.05ms** |
| `audit_log`, `event_type` filter only | Seq Scan, 100k rows scanned, **1614 buffers, 6.9ms** | Index Scan, **45 buffers, 0.17ms** |
| `inventory_transactions`, no filter (ops browsing ledger) | Parallel Seq Scan, 200k rows, **3765 buffers, 14.6ms** | Index Only Scan, **4 buffers, 0.04ms** |
| `inventory_transactions`, `txn_type` filter only | Seq Scan, 200k rows scanned, **3765 buffers, 9.8ms** | Index Scan, **55 buffers, 0.18ms** |

Fix, in a new migration (001–007 untouched):

```
db/migrations/008_list_query_indexes.sql
  CREATE INDEX idx_audit_occurred ON audit_log (occurred_at DESC, id DESC);
  CREATE INDEX idx_inventory_transactions_created ON inventory_transactions (created_at DESC, id DESC);
```

Same shape as the existing `idx_orders_created` / `idx_products_created` fallback indexes — applied to the two tables that were missing that pattern. Each index's comment in the migration names the exact query it serves. Verified the file applies cleanly through the real migrator (`schema_migrations` checksums) on a second fresh scratch database, migrations 001→008 in order.

Everything else checked and found already adequate, not touched:
- `orders`, `products`, `warehouses`, `organizations`: all filter combos fast (existing indexes or table small enough that a seq scan is cheap and correctly chosen by the planner — warehouses=25 rows, organizations=601 rows).
- `users` (3,050 rows) / `org_members`: all combos <5ms even with hash joins across three tables — table is deliberately kept small ("a few thousand users"), not worth indexing.
- `inventory` (75k rows): existing unique `(product_id, warehouse_id)` index and `idx_inventory_warehouse` cover both filter directions via nested loop / bitmap scans, all <1ms.
- `inventory_transactions` by `order_id`, `inventory_id` (existing per-FK indexes): already fast, unaffected.
- `price_lists`: `idx_price_lists_org` already handles the `org_id IS NULL OR org_id = $1` scope predicate via `BitmapOr`; table is small (501 rows) so the one seq-scan case (ops all-buyers + status, no org_id) costs 9 buffers — not worth a new index.
- `outbox_events`: `ORDER BY id DESC` always rides the primary key backward, for every status value including the previously-untested `dead` and `processed` cases — no new index needed; the existing partial `idx_outbox_pending` still serves the relay's own poll query.
- `products.name` / `users.full_name` `ILIKE '%...%'`: leading-wildcard, not addressable by a plain btree; would need `pg_trgm`, which is a bigger architectural addition than "add the missing index" and the tables are deliberately small — noted, not added. If products/users ever grow past a few thousand rows, revisit with `pg_trgm`.

## 2. Error-code consistency

Read every module's `domain/errors.ts` (catalog, identity, inventory, ordering, pricing — audit has none by design, it's a read-only projection with no expected-failure path, consistent with its own "stay at three files" note), `platform/errors/domain-error.ts`, `platform/errors/all-exceptions.filter.ts`, and `platform/validation/zod-validation.pipe.ts`.

Found already correct and left alone:
- Codes are UPPER_SNAKE everywhere, one factory per situation, no ad hoc strings at call sites.
- Same situation → same code across modules: `INVALID_QUANTITY` (inventory, pricing), `notFound()`/`forbidden()`/`conflict()`/`badRequest()` helpers reused everywhere so 404/403/409/400 status always matches the code family.
- Scope violations render as `NOT_FOUND` (never `FORBIDDEN`) in ordering (`order.service.ts` — explicit comment), identity (`assertOrgInScope`), and pricing (`priceListNotFound` via scoped `findById`) — verified by reading `org-scope.ts` and every call site of `organizationNotFound()`/`priceListNotFound()`/`userNotFound()`; no existence leak anywhere.
- `AllExceptionsFilter` maps anything that isn't a `DomainError`/`HttpException` to `{ code: 'INTERNAL_ERROR', message: 'Internal server error.' }` at 500, logs the real stack server-side only, never serialises internals to the client. Confirmed every `throw new Error(...)` in the codebase (money parsing, migrator, outbox relay, scheduler, idempotency-repository invariant checks) is a genuine programmer-invariant violation, correctly falling through to that 500 path rather than being misclassified as a 4xx.
- `ZodValidationPipe` is the single shared validator used by every controller (verified via grep — 12 controllers, one pipe); every validation failure renders through the same `BadRequestException({ message, details })` shape, landing on `BAD_REQUEST` via the filter's `codeForStatus` fallback. One envelope, no divergence.

Found and fixed (real inconsistency, no public contract change — same codes/statuses, just made explicit instead of relying on a fallback):

- `apps/api/src/modules/identity/http/jwt-auth.guard.ts` — was throwing raw `UnauthorizedException('Missing bearer token.')` / `UnauthorizedException('Invalid or expired token.')`, bypassing `domain/errors.ts` entirely (only reached `code: 'UNAUTHORIZED'` by relying on the filter's generic `codeForStatus(401)` fallback string, not the module's own error table). Added `IdentityErrors.missingToken()` / `IdentityErrors.invalidToken()` (both `UNAUTHORIZED`/401, same messages as before) and a new `unauthorized(code, message)` helper in `domain-error.ts` (sibling to `notFound`/`forbidden`/`conflict`/`badRequest`). Guard now throws through the module's own error table like every other identity failure.
- `apps/api/src/modules/identity/http/roles.guard.ts` — was throwing raw `ForbiddenException(...)` with a message that happens to be byte-identical to `domain/actor.ts`'s `assertRole()` (the equivalent application-layer check). Replaced with `forbidden(...)` from `platform/errors/domain-error.ts`, so the route-level guard and the service-level `assertRole` re-check now literally share the same call, not two independently-maintained strings that could drift.
- `platform/errors/domain-error.ts`'s `forbidden(message = 'You do not have access to this resource.')` had a default that was never exercised — grepped all 4 call sites, every one passes an explicit message. Removed the dead default; `message` is now required, closing off a silent drift where some future caller invokes `forbidden()` bare and gets a generic message nobody reviewed.

No HTTP status or `error.code` value changed for any existing response — verified by cross-checking the fallback `codeForStatus()` mapping against the new explicit codes before making the change, and confirmed by the full test suite still passing unmodified elsewhere.

### Tests added/adjusted

`apps/api/test/identity/roles-guard.spec.ts` — the existing suite already asserted `error.code === 'UNAUTHORIZED'` for the no-token case and 403 status for role failures, but not the `error.code` for the tampered/expired-token and role-denied cases. Added `error.code` assertions for:
- tampered/malformed bearer token and expired token → `UNAUTHORIZED` (now guaranteed by `IdentityErrors`, not a filter fallback),
- ops-only route hit by a non-`ops_admin` role, and `/users` hit by a non-admin role → `FORBIDDEN` (now guaranteed to match `use-case-authorization.spec.ts`'s `{ code: 'FORBIDDEN', status: 403 }` expectation for the equivalent service-layer check).

## 3. Dead code

Swept `apps/api/src` (platform/, and every module's domain/application/infrastructure/http layers) for exports referenced nowhere outside their own declaration. Method: extracted every top-level `export function/const/class/interface/type` name per layer, then grepped the whole repo (including tests and `packages/`) for each; anything appearing only on its own declaration line was inspected by hand (most were false positives — types used structurally within their own file, e.g. `CreateOrderInput`, `OrderBlocker`, never re-imported by name elsewhere, which is normal, not dead). Two were genuinely dead:

- **`isForeignKeyViolation`** (`apps/api/src/platform/database/sql.ts`) — sibling of `isUniqueViolation` (which *is* used by product/warehouse/user/organization repositories), but had zero call sites anywhere in the repo, including tests. Deleted.
- **`normalizeEmail`** (`apps/api/src/modules/identity/domain/user.ts`) — "ported from StockFlow's Filter.Normalize()", but never called. The equivalent normalisation (`trim().toLowerCase()`) already happens inline in the Zod boundary schema (`packages/contracts/src/identity.ts`), so this was a superseded duplicate, never wired in. Deleted.

No TODO/FIXME/XXX markers found anywhere in `apps/api/src`, `apps/web/src`, or `packages/`. No dead files found (every controller/module/service file is reachable from a `*.module.ts` registration or imported by one that is). Did not touch `.env.example` (out of my file ownership) — did not find time to cross-reference every env var against `docker-compose.yml`/`scripts/seed.ts` consumers either, since that file and `scripts/` are owned by the main session; flagging as unchecked rather than guessing.

## Files changed

- `db/migrations/008_list_query_indexes.sql` (new) — 2 indexes, justified above.
- `apps/api/src/platform/errors/domain-error.ts` — added `unauthorized()`, removed dead default on `forbidden()`.
- `apps/api/src/modules/identity/domain/errors.ts` — added `IdentityErrors.missingToken()` / `.invalidToken()`.
- `apps/api/src/modules/identity/http/jwt-auth.guard.ts` — routes through `IdentityErrors` instead of raw `UnauthorizedException`.
- `apps/api/src/modules/identity/http/roles.guard.ts` — routes through `forbidden()` instead of raw `ForbiddenException`.
- `apps/api/src/platform/database/sql.ts` — removed dead `isForeignKeyViolation`.
- `apps/api/src/modules/identity/domain/user.ts` — removed dead `normalizeEmail`.
- `apps/api/test/identity/roles-guard.spec.ts` — added `error.code` assertions for the paths above.

No files outside `apps/api/` and `db/migrations/` touched. `apps/web`, `docs/`, `README.md`, `scripts/`, `.env.example` untouched. No commits made.

## Verification

- `pnpm typecheck` (all 4 workspace packages) — pass.
- `pnpm lint` — pass, no warnings.
- `bash scripts/verify-architecture.sh` — exit 0 (`ok` on all 4 applicable checks, `n/a` on the copilot check since that module doesn't exist yet).
- `pnpm test` — **85 test files, 423 tests, all pass**, exit 0. Includes `no-oversell-concurrent.spec.ts` (10 runs) and every scheduler/outbox concurrency test. Ran once cleanly; a separate long-running loop of the same concurrent spec was active throughout in another process (per the task brief) and did not conflict — each run uses its own testcontainers.
- Scratch Postgres container and scratch database fully removed after use; `docker ps` confirmed `stockflow-v2-postgres-1` and the rest of the compose stack were `Up ... (healthy)` before, during, and after — never touched.

Status: DONE

Summary: Ran a full EXPLAIN sweep against a throwaway 100k-order/200k-ledger/120k-outbox/100k-audit Postgres instance covering every list-with-filter query the HTTP layer exposes; found orders/products/warehouses/organizations/users/inventory/price_lists/outbox already adequately indexed, and two real gaps (audit_log, inventory_transactions had no fallback sort index) fixed in a new migration 008, cutting those queries from ~7-15ms/1600-3700 buffers to <0.2ms/<60 buffers. Audited error-code consistency across every module; found the error-code table itself already very consistent (scope-vs-404, shared code families, single validation envelope, correct 500 fallback) and fixed two guards that bypassed `domain/errors.ts` via raw Nest exceptions (no status/code change, now structurally tied to the same source of truth), plus removed one dead default parameter. Deleted two genuinely dead exports after a repo-wide reference sweep. All verification gates green.

Concerns: I did not audit `.env.example` variables against their consumers (out of my file ownership, and `docker-compose.yml`/`scripts/` — the other plausible consumers — are also owned by the main session), so an unused env var there, if one exists, is unconfirmed either way. Rate-limit coverage on login/copilot (a separate bullet in the same plan step) was not in my assigned scope and was not checked.
