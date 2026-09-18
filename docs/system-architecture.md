# System Architecture

The StockFlow v2 backend is a modular monolith. It has six business modules (`identity`, `catalog`, `inventory`, `ordering`, `pricing`, `audit`) and a platform layer (`config`, `database`, `errors`, `health`, `http`, `observability`, `outbox`, `ratelimit`, `redis`, `scheduler`, `validation`). The platform layer provides mechanism without policy. The frontend is a React SPA (ADR 0025). This document describes the invariants the system keeps, where the code enforces them, and the trade-offs made to hold them.

## Module Layout

| Layer | Location | Contains |
|---|---|---|
| `domain/` | `apps/api/src/modules/{name}/domain/` | Entities, value objects, errors, pure rules. No I/O. |
| `application/` | `apps/api/src/modules/{name}/application/` | Use cases, services and **ports** (narrow interfaces). Use cases never open transactions. `IdempotencyService` is the one documented exception (ADR 0015). |
| `infrastructure/` | `apps/api/src/modules/{name}/infrastructure/` | Handwritten SQL implementing ports. No ORM. |
| `http/` | `apps/api/src/modules/{name}/http/` | Controllers and presenters. Request schemas live in `packages/contracts`. |

`audit` is small and has no `domain/` folder. Other modules may use another module's application services and domain types (errors, `Money`, `Actor`, `OrgScope`). The only cross-module infrastructure import is `identity/infrastructure/scope-sql.ts`, and that is deliberate.

The root `eslint.config.mjs` enforces three import boundaries. `platform/` never imports `modules/`. `packages/ai-harness` never imports the application. `modules/copilot/` (not built yet) never imports `pg` or any `infrastructure/`. `scripts/verify-architecture.sh` adds grep gates. See `docs/code-standards.md` for the full set.

## Chapter 1: Concurrency & Transactions

**Invariant:** No oversell. Every stock move writes a ledger row. Transactions never nest.

### Where it is enforced
- **No oversell:** `create-order.use-case.ts` (`reserveStock`) reserves each line through `StockMovementService.reserve`. That calls `reserveAtomic` in `apps/api/src/modules/inventory/infrastructure/sql-inventory.repository.ts`: `UPDATE inventory SET available_qty = available_qty - $3, reserved_qty = reserved_qty + $3 … WHERE product_id = $1 AND warehouse_id = $2 AND available_qty >= $3`. Zero rows back means insufficient stock. The use case throws `INSUFFICIENT_STOCK` (409), and the transaction rollback undoes every earlier reservation. Test: `apps/api/test/ordering/no-oversell-concurrent.spec.ts` runs 50 concurrent orders for 10 units. Exactly 10 succeed and exactly 40 get 409, repeated over 10 runs.

- **Every stock move writes a ledger row:** `apps/api/src/modules/inventory/application/stock-movement.service.ts`. Every movement (`adjust`, `reserve`, `release`, `consume`) goes through its private `record()`. That writes the ledger row via `LedgerRepository.append` in the same transaction. `inventory_transactions` (`db/migrations/005_inventory.sql`) is append-only; its repository exposes no update or delete. Tests: `apps/api/test/inventory/ledger-guarantees.spec.ts`, `stock-movements.spec.ts`.

- **One lock order:** `orders` (by id) → that order's `inventory_reservations` → `inventory` (by product id) (ADR 0013, `docs/code-standards.md` §3). Four paths write stock. Create order locks no existing order and touches stock in product-id order. Cancel/expire/fulfil lock the order row first. The expiry sweep calls the same expire use case, one order per transaction. Adjust changes one row in one statement. Mark-paid changes no stock. Tests: `apps/api/test/ordering/no-deadlock-crossing.spec.ts`, `no-deadlock-mixed-flows.spec.ts`.

- **Explicit transaction boundary:** every use case takes `tx: Tx`. Controllers and jobs call `UnitOfWork.withTransaction()` (`apps/api/src/platform/database/unit-of-work.ts`); use cases never do. `createPool` (`platform/database/pool.ts`) puts READ COMMITTED isolation, `lock_timeout` (5 s default) and `statement_timeout` (15 s default) in the connection startup packet. ADR 0004. Tests: `apps/api/test/platform/transaction-settings.spec.ts`, `apps/api/test/scheduler/no-nested-transaction.spec.ts`.

### Trade-off
Heavy contention on one SKU forms a queue: orders wait on that stock row for the length of one order transaction. That is the price of never overselling. Stock is reserved last in the transaction, so the lock is held as briefly as possible (ADR 0013).

---

## Chapter 2: Pricing as a Policy Engine

**Invariant:** The server decides every price a buyer pays. A client cannot choose a price, and each order line records where its price came from.

### Where it is enforced
- **One port:** `apps/api/src/modules/pricing/application/ports/price-resolver.ts`. `PriceResolver.resolve(tx, scope, customer, lines, at)` is called by both quoting (`POST /pricing/quote`) and order creation (ADR 0011). The create-order request schema (`createOrderRequestSchema` in `packages/contracts/src/ordering.ts`) has no price field. Zod strips unknown keys, so a `unit_price` in the body never reaches the use case.

- **Implementation:** `apps/api/src/modules/pricing/infrastructure/sql-price-resolver.ts` runs two queries whatever the cart size. The first loads products through `CatalogService`; the second loads the candidate tiers. The policy is `pickPrice()` (`apps/api/src/modules/pricing/domain/pick-price.ts`), a pure function tested without a database. It keeps active rows valid at the given time for this customer's contract or the default list, with `min_qty <= qty`. It picks one list: contract before default, then higher priority, then newer `valid_from`, then list id. Within that list it takes the largest tier not above the quantity. With no usable row it falls back to the product's `base_price`.

- **Traceability:** each `order_items` row (`db/migrations/006_ordering.sql`) stores the `unit_price` and `line_total` charged, plus `price_list_item_id` (NULL when the base price applied). Orders never re-read prices later. The quote response also reports `source_kind` (`contract` / `default_list` / `base_price`), `price_list_id` and `min_qty_applied`.

- **Contract lists belong to buyers:** `price_lists` (`db/migrations/004_pricing.sql`) has a composite FK `(org_id, org_type) → organizations (id, type)`. The `chk_price_list_owner` constraint allows either a default list (no org) or a list owned by a `buyer` org. The resolver calls `assertOrgInScope` before pricing. Tests: `apps/api/test/pricing/price-resolver.spec.ts`, `pricing-constraints.spec.ts`, `apps/api/test/ordering/price-from-server.spec.ts`.

### Trade-off
The policy lives in application code (`pickPrice`), not in SQL. The SQL only pre-filters by customer and validity window, and `pickPrice` applies the full rule set again. The rule stays readable and unit-testable. The cost is that every candidate tier for the cart is loaded into memory.

---

## Chapter 3: Outbox & Eventual Consistency

**Invariant:** A status change and its event are written in the same transaction. Events are delivered at least once. Consumers are idempotent.

### Where it is enforced
- **Atomic write:** every order status change writes one `outbox_events` row in the same transaction, with the buyer organisation as `org_id`. The events are `order.created` (in `create-order.use-case.ts`) and `order.cancelled` / `order.expired` / `order.paid` / `order.fulfilled` (in `order-transition.use-cases.ts`). Repeating a transition that already happened writes nothing. `outbox_events` is created in `db/migrations/006_ordering.sql`. Test: `apps/api/test/ordering/outbox-same-tx.spec.ts`.

- **Claim by row lock, not by status:** `OutboxRelay.claimAndDispatch` in `apps/api/src/platform/outbox/outbox.relay.ts` runs `SELECT … FROM outbox_events WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`. The same transaction claims, dispatches and marks the events. `attempts` counts failed dispatches, never claims. If the process crashes between claim and dispatch, the transaction rolls back, the lock is released, and the event is pending again, unchanged. Tests: `apps/api/test/outbox/crash-after-claim.spec.ts`, `relay-concurrent-claim.spec.ts`.

- **Savepoint per event:** each event runs under `SAVEPOINT outbox_event`. After a handler succeeds, the relay marks the event `processed` and then releases the savepoint. After any error, it rolls back to the savepoint and then records the failure. Without the savepoint, a handler's SQL error would abort the whole claiming transaction. The failure could not be recorded, and the event would block the head of every later batch. Retries back off exponentially: 200 ms doubling, capped at 30 s, with jitter. After `OUTBOX_MAX_ATTEMPTS` (default 8) the event becomes `dead`. Tests: `apps/api/test/outbox/handler-sql-failure.spec.ts`, `retry-backoff.spec.ts`, `dead-event-does-not-block.spec.ts`, `unknown-event-type.spec.ts`.

- **Handlers are idempotent:** `apps/api/src/modules/audit/application/audit-log.handler.ts`. `audit_log.event_id` (`db/migrations/007_outbox_audit.sql`) is a `UNIQUE` bigint referencing `outbox_events(id)`, and the handler inserts with `ON CONFLICT (event_id) DO NOTHING`. A redelivered event writes nothing new. Test: `apps/api/test/outbox/handler-idempotent.spec.ts`.

- **One source of truth:** `status` is the only "has this been handled" predicate. The claim query and `crash-after-claim.spec.ts` share one constant, `OUTBOX_PENDING_PREDICATE`. `idx_outbox_pending` is a partial index `WHERE status = 'pending'`. `processed` and `dead` rows are never deleted: ADR 0017 records this as known debt, since there is no retention job. Test: `apps/api/test/outbox/single-source-of-truth.spec.ts`.

### Trade-off
One poll holds one transaction open for its whole batch. `OUTBOX_BATCH_SIZE` defaults to 20 and is capped at 64, because each event is a subtransaction and Postgres slows down past 64 of them. Several relay instances can poll at once and `SKIP LOCKED` gives them different rows, so ordering is only relative (`ORDER BY id`). No handler may assume a global order.

---

## Chapter 4: Multi-Tenant Boundary & RBAC

**Invariant:** A buyer cannot read another organisation's data. Ops read buyer data through `OrgScope`, never through a bypass. Out-of-scope reads return 404.

### Where it is enforced
- **OrgScope is required:** `apps/api/src/modules/identity/domain/org-scope.ts`. Services that read organisation-owned data take an `OrgScope`, never a bare id:
  - `single` — one organisation (every buyer);
  - `all-buyers` — every buyer organisation, never the internal one (ops reading commerce data);
  - `all` — every organisation (ops administering identity).

  `orgScopeOf(actor)` gives ops `all-buyers` and buyers `single`. `identityScopeOf(actor)` gives ops `all`. Tests: `apps/api/test/identity/org-scope.spec.ts`, `tenant-isolation.spec.ts`, `apps/api/test/ordering/scope.spec.ts`, `apps/api/test/audit/scope.spec.ts`.

- **Scope becomes SQL in one place:** `apps/api/src/modules/identity/infrastructure/scope-sql.ts` (`scopeSql`). The order, reservation and price-list repositories all use it. `all-buyers` filters on the organisation *type*, so it can never match the internal organisation. The audit repository has its own equivalent. `assertOrgInScope` throws "not found" rather than "forbidden", so the check does not confirm that an out-of-scope organisation exists.

- **Role ↔ organisation type at the database level:** in `db/migrations/002_identity.sql`, `org_members` has a composite FK `(org_id, org_type) → organizations (id, type)` and `CHECK chk_role_matches_org_type`. `ops`/`ops_admin` are only allowed in the internal organisation, and `buyer`/`buyer_admin` only in buyer organisations. Account-level changes (password, activation, name) are refused when the user also belongs to an organisation outside the admin's scope. ADR 0007. Tests: `apps/api/test/identity/role-org-type-constraint.spec.ts`, `apps/api/test/identity/users-api.spec.ts`.

- **Roles are checked twice:** `@Roles(...)` on routes, and `assertRole(actor, ...)` inside use cases. Jobs, and later agent tools, call use cases without HTTP, so the use-case check must hold on its own (`docs/code-standards.md` §5). Tests: `apps/api/test/identity/use-case-authorization.spec.ts`, `roles-guard.spec.ts`.

### Trade-off
Tenancy lives in application code, so every new query must remember to take a scope. The type system forces the parameter, and isolation tests cover the read paths. Postgres row-level security was deferred (ADR 0008): with a shared pool, a forgotten or leaked `SET LOCAL` is itself a cross-tenant bug, and the ops "every buyer" scope would make the policies conditional.

---

## Chapter 5: Agent over Domain Tools (Planned, Not Built)

**Status:** not started. Phases 07–08 depend on the Phase 00 Bedrock spike, which waits for AWS credentials (ADR 0003). `packages/ai-harness` is an empty placeholder, and there is no `modules/copilot`.

**Design invariant:** an agent never has more privilege than the user who invoked it. A tool call is a call to an application service, with that user's `Actor` and `OrgScope`.

### What the spike must establish (ADR 0003)
`scripts/spike-bedrock.mts` (`pnpm spike:bedrock`) talks to Bedrock through LiteLLM, using the aliases `default-chat` (Claude Haiku 4.5) and `default-embed` (Cohere Embed Multilingual v3). It must record three facts:
- whether the chat model answers;
- the embedding dimension (expected 1024; this fixes `vector(N)` in the `ai` schema);
- whether the Strands SDK's `agent.stream()` surfaces tool-call lifecycle events. Its types declare `beforeToolCallEvent` / `afterToolCallEvent`, but the reference AI-Harness code only ever saw `textDelta`.

If the stream does not surface tool events, the harness needs its own tool loop (about 2–3 days, already budgeted) instead of mapping SDK events (about half a day).

### Planned enforcement (Phase 07–08 plans)
- **Tools are built per request from the caller's `Actor`.** Each tool calls an application service that already takes an `OrgScope` and calls `assertRole`. There is no path that runs with other privileges.
- **Tool schemas have no tenant field for the model to fill.** Where a tool must name a customer (`get_contract_price`), the id is checked with `assertOrgInScope` before use.
- **The only write tool creates a proposal** (`propose_stock_adjustment`). A person approves it, and approval goes through the existing `AdjustStockUseCase`.
- **Import rule:** `modules/copilot/` may not import `pg` or `infrastructure/` (already in `eslint.config.mjs`). `scripts/verify-architecture.sh` also greps it for SQL.
- **Sessions are owned:** chat sessions carry the tenant and owner user, and another tenant's session returns 404.

ADRs 0020–0024 are reserved for these decisions.

---

## Interaction Between Invariants

1. **Concurrency ↔ Pricing:** create-order prices the cart (two queries) before any stock row is locked, inside the same transaction. The order stores the prices it charged and never re-reads them (ADR 0011).

2. **Transaction ↔ Outbox:** the `tx: Tx` a use case receives is the transaction that both changes the order and writes its event (ADR 0004, 0017).

3. **Multi-tenant ↔ Outbox:** every `outbox_events` row has a non-null `org_id` (the order's buyer organisation). `audit_log` copies it as NOT NULL, audit reads go through `OrgScope`, and `GET /ops/audit` is `ops_admin`-only (ADR 0019).

4. **Transactions ↔ Concurrency:** the single lock order prevents deadlock. A status change settles the whole order or nothing; there is no intermediate "releasing" state (ADR 0013, 0018).

---

## Related Documentation

- `docs/code-standards.md`: rules for each layer (transactions, money, tenancy, ledger, errors, tests, outbox handlers).
- `docs/adr/index.md`: ADRs 0001–0019 and 0025.
- `docs/decisions-vs-stockflow.md`: what v2 ports from StockFlow (Go) unchanged, and what it changes on purpose.
- `docs/diagrams/`: components, order creation, outbox relay, planned copilot flow.
- `scripts/verify-architecture.sh`: grep gates (platform never imports modules, ai-harness never imports apps, copilot never touches SQL, money is never a float, no "releasing" state).
