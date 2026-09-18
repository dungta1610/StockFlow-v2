# Decisions vs StockFlow (Go)

What v2 ports from `StockFlow` unchanged, what it changes on purpose, and why. Every
difference here is deliberate; a difference that is not listed is a bug.

## Ordering

Source: `module/order/storage/sql_order_tx.go` (`CreateOrder`, `CancelOrder`,
`ExpireOrder`, `generateOrderCode`), `module/order/model/*`,
`module/inventory/model/inventory_reservation.go`.

### Ported as is
| StockFlow | v2 |
|---|---|
| Routes `POST /orders`, `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel`, `POST /orders/:id/expire` | same paths |
| `SELECT … FOR UPDATE` on the order before cancel/expire | same: the order row lock is the first lock and the claim |
| Refusals: paid / fulfilled / completed / expired cannot be cancelled; paid / cancelled / fulfilled / completed cannot be expired | same rules, now a table in `order-state-machine.ts` |
| Eight statuses in the enum | the `CHECK` constraint accepts all eight |
| `order_code` format `ORD-YYYYMMDD-NNNNNN` | same shape |
| List filters: order code, warehouse, status; newest first; page/limit paging | same, plus `buyer_org_id` for ops |
| Validation: items required, quantity > 0 | same, plus "each product once" |

### Changed on purpose
| StockFlow | v2 | Why |
|---|---|---|
| `CreateOrder` never touched stock; `inventory_reservations` had no caller | every line reserves stock with a conditional update in the order's transaction; one shortfall rolls the whole order back | oversell was possible (ADR 0013) |
| Cancel / expire only changed the status | they release every held reservation; fulfil consumes them | stock stayed held forever |
| Client sent `unit_price`; `line_total = unit_price × qty` | no price field in the request; prices come from `PriceResolver`, each line records `price_list_item_id` | a buyer chose their own price (ADR 0011) |
| `float64` money, `total_amount` | `numeric(18,2)` / `Money`; `subtotal` and `total` | floats cannot hold money exactly (ADR 0010) |
| `RANDOM()` six digits + `UNIQUE` | global sequence, padding that widens | collisions failed transactions (ADR 0014) |
| `user_id` on the order, no tenant | `buyer_org_id` + `placed_by_user_id`, every read through `OrgScope`; out-of-scope reads are 404 | multi-tenant B2B |
| `pending` when `reservation_expires_at` was nil | never produced; hold length is server config (`ORDER_RESERVATION_TTL_MINUTES`), not client input | every order holds stock (ADR 0016) |
| `awaiting_payment`, `completed` in the flow | never produced; `mark-paid` records payment | payment module cut (ADR 0016) |
| Cancel twice → `ErrOrderAlreadyCancelled`; expire twice → `ErrOrderAlreadyExpired`; cancel an expired order → `ErrOrderCannotBeCancelled` | repeating a transition returns the order unchanged, 200; so does cancelling an expired order or expiring a cancelled one | cancel / expire / fulfil / mark-paid must be safe to retry, and a buyer's cancel may race the expiry sweep |
| Order not found on cancel → `nil, nil` | `404 ORDER_NOT_FOUND` | a silent nil hid the failure |
| No idempotency | `Idempotency-Key` on create; claim committed first, key freed on failure | retries after a timeout must not double-order (ADR 0015) |
| No events | `outbox_events` row in the same transaction as every change | reliable hand-off to phase 05 |
| Reservation `status` was a free-text column with no defined values (and no caller) | only `held / released / consumed`, enforced by a `CHECK` | an intermediate "releasing" state could strand stock after a crash (red team finding #1) |
| No stock check, so no shortfall error | `409 INSUFFICIENT_STOCK` carries `product_id`, `sku`, `requested` and the exact `available` quantity | as specified in the plan; this reveals stock levels to buyers, although inventory endpoints are ops-only. **Open question**, see ADR 0013 |

## Catalog & Warehouses

Source: `module/warehouse/model/*`, `module/warehouse/storage/*.go`, `module/product/model/*`, `module/product/storage/*.go`.

### Ported as is
| StockFlow | v2 |
|---|---|
| Product fields: id, sku, name, description, is_active, created_at, updated_at; SKU upper-cased | same (SKU normalisation is also a `CHECK`) |
| Warehouse fields: id, code, name, address, is_active, created_at, updated_at; code upper-cased | same (code normalisation is also a `CHECK`) |

### Changed on purpose
| StockFlow | v2 | Why |
|---|---|---|
| Product `price` as `float64` | `base_price numeric(18,2)`: the list price, and the fallback when no price-list tier applies | floats cannot hold money exactly; buyers are charged their contract price, so the product price is only the base (ADR 0010, 0011) |
| No currency column | `currency` on `products`, `price_lists` and `orders`, fixed by `CHECK (currency = 'VND')`; products also gain `uom` | a currency column nothing checks is worse than none; widening it is one migration plus `Money` (ADR 0010) |
| No pricing at all: the client sent `unit_price` | `price_lists` (per-buyer contract lists and a default list) with `price_list_items` (quantity tiers by `min_qty`, validity window, priority) | B2B buyers pay contract prices |
| — | `PriceResolver.resolve()` runs two queries whatever the cart size (ADR 0011) | pricing runs inside the create-order transaction and must not become N+1 |

## Inventory & Stock Ledger

Source: `module/inventory/model/*`, `module/inventory/storage/*.go`.

### Ported as is
| StockFlow | v2 |
|---|---|
| `inventory`: product + warehouse, `available_qty`, `reserved_qty`, `version` | same columns, plus `CHECK`s that neither quantity goes negative |
| `inventory_transactions`: one row per movement with before/after available and reserved quantities, `order_id`, `reservation_id`, `reason`, `created_by`; the code only ever inserts | same columns; repositories expose no update or delete |
| `version` incremented on every change, not used as an optimistic lock (adjust locked with `FOR UPDATE`) | same: an audit counter only (ADR 0012) |

### Changed on purpose
| StockFlow | v2 | Why |
|---|---|---|
| Adjust: `SELECT … FOR UPDATE`, then `INSERT` when no row was found. `FOR UPDATE` locks nothing when there is no row, so two first adjustments for a new product/warehouse pair raced | `INSERT … ON CONFLICT (product_id, warehouse_id) DO NOTHING` (increases only), then one conditional `UPDATE … WHERE available_qty + $delta >= 0` | the first-time race is gone, and a decrease that would go negative changes nothing (ADR 0012) |
| No code path reserved, released or consumed stock (a reservation insert existed with no caller); the only ledger type ever written was `manual_adjustment` | reserve / release / consume are single conditional `UPDATE`s (e.g. reserve `… WHERE available_qty >= $qty`); zero rows back = the condition failed and nothing changed; `txn_type` limited by `CHECK` to `manual_adjustment`, `reserve`, `release`, `consume` | stock actually moves with orders (ADR 0012, 0013) |
| `order_id` / `reservation_id` on the ledger; the repo had no migrations, so no declared foreign keys | FKs `fk_itx_order` and `fk_itx_reservation` (the latter `DEFERRABLE INITIALLY DEFERRED`, because the ledger row is written before its reservation row) | every order-related ledger row points at a real order and reservation |

## Identity & Access Control

Source: `module/user/model/*` (Go had no multi-tenancy; this is new).

### Changed on purpose
| StockFlow | v2 | Why |
|---|---|---|
| `users` with a single `role` column (email, password_hash, full_name, is_active) | `users` (account: email as `citext`, password_hash, full_name, is_active) + `org_members` (one role per organisation membership) | B2B: a user can belong to several organisations with a different role in each |
| No login or token handling (the `password_hash` column was never checked) | HS256 access token (15 min) + rotating refresh token (7 days, reuse revokes the whole family, 30-day absolute session) in an `HttpOnly; SameSite=Strict` cookie; refresh/logout reject an `Origin` outside `CORS_ORIGINS`; login throttled to 5 failures per account and 20 per client IP per 900 s (ADR 0009) | the API is multi-tenant and must authenticate every caller |
| `role` stored but never enforced | roles `buyer`, `buyer_admin` (buyer organisations) and `ops`, `ops_admin` (the `internal` organisation), checked by `@Roles` on routes and `assertRole` in use cases | buyers see only their own organisation; ops work across buyers |
| No organisations, so no scope | `OrgScope`: `single` / `all-buyers` / `all` (ADR 0007); ops get `all-buyers` for commerce data and `all` for identity | ops staff sit in the internal organisation, so filtering by the caller's own org id would show them nothing |
| — | composite FK `(org_id, org_type)` + `CHECK chk_role_matches_org_type`: `ops`/`ops_admin` only in the internal org, `buyer`/`buyer_admin` only in buyer orgs | the database refuses a membership that would give a buyer organisation's user an ops role |
| Global rate limit 100 requests/min per client + path (Redis) | same limiter and defaults (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SECONDS`) | ported as is |

---

## Summary: What v1 Does Not Have (Intentional)

| Category | Not in v1 | Reason | Next step |
|---|---|---|---|
| **Payment** | no payment module, gateway or callbacks (Phase 06 cancelled) | teaches no invariant ordering does not already teach; its simulated callback had an auth hole (red team finding #7). Ops record payment with `POST /orders/:id/mark-paid` (ADR 0016) | not scheduled |
| **Buyer portal** | no separate portal (Phase 10 cancelled); buyers use the same console to place and view their own orders | no new invariant | v1.1 |
| **Multi-currency** | `VND` only, fixed by `CHECK` constraints | a currency column nothing checks is worse than none (ADR 0010) | drop the `CHECK`, add a currency to `Money`, refuse cross-currency arithmetic |
| **Postgres RLS** | tenancy enforced in the repositories through `OrgScope` | a leaked `SET LOCAL` on a shared pool is itself a cross-tenant bug; ops' all-buyers scope makes policies conditional (ADR 0008) | revisit when other services or tools query the database directly |
| **Copilot** | nothing built; the ops copilot is planned for Phase 08, and there is no buyer copilot | depends on Phase 07 | Phases 07–08 |
| **AI harness** | nothing built; `packages/ai-harness` is an empty placeholder | the Bedrock spike (ADR 0003) has not run for lack of AWS credentials. It must establish whether the model answers, the embedding dimension, and whether the Strands SDK's `agent.stream()` surfaces tool lifecycle events | Phases 07–08 once the spike has run |

