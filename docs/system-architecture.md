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

The root `eslint.config.mjs` enforces three import boundaries. `platform/` never imports `modules/`. `packages/ai-harness` never imports the application. `modules/copilot/`'s `application/` and `http/` never import `pg` or any `infrastructure/`. `scripts/verify-architecture.sh` adds grep gates. See `docs/code-standards.md` for the full set.

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

## Chapter 5: Agent over Domain Tools

**Invariant:** an agent never has more privilege than the person who invoked it. A tool
call is a call to an application service, with that person's `Actor` and `OrgScope`.

The claim worth checking is not that the copilot is useful — it is that adding it opened no
new way into the data. It did not, because it has no data access of its own.

### Enforced by
- **Tools are built per request, from factories.** `ToolFactory` receives the `RunContext`;
  the handler resolves the caller from it on every call, so a role revoked mid-conversation
  takes effect on the next tool call. An instance built once at boot would keep the first
  caller's scope and hand it to everybody after. Test:
  `apps/api/test/copilot/tool-respects-rbac.spec.ts`.
- **A tool is a zod schema plus one call to an application service.** Those services already
  take an `OrgScope` and call `assertRole`, so the agent travels the road the HTTP
  controllers travel. `modules/copilot/application/` and `http/` contain no SQL and import
  no repository — enforced by `eslint.config.mjs`,
  `scripts/verify-architecture.sh` and `apps/api/test/copilot/no-sql-in-copilot.spec.ts`.
  No text-to-SQL, anywhere (ADR 0023).
- **No tool schema has a tenant field for the model to fill.** Scope comes from the caller.
  The one tool that must name a customer (`get_contract_price`) takes its *code*, resolves
  it inside the caller's scope, and re-checks with `assertOrgInScope`. Test:
  `copilot/tool-scope.spec.ts` asserts structurally that no other tool has such a field.
- **Instructions hidden in data change nothing**, because the limit on a result is a `WHERE`
  clause derived from the caller before the model is involved. Test:
  `copilot/prompt-injection.spec.ts` puts an injection in a product name.
- **The only write tool creates a proposal** (`propose_stock_adjustment`); stock is unchanged
  until an `ops_admin` — never the author — approves, and approval runs the ordinary
  `AdjustStockUseCase`. `chk_no_self_decision` holds the "second person" rule in the
  database. Tests: `copilot/propose-does-not-write-stock.spec.ts`,
  `approve-proposal.spec.ts`, `self-approval-blocked-in-db.spec.ts` (ADR 0024).
- **Sessions are owned.** `ai.chat_sessions` carries `tenant_id` and `owner_user_id`, and
  every read filters on the tenant; another tenant's session is a 404. A transcript holds
  whatever the tools looked up, so reading one is reading that data (ADR 0022).
- **Memory namespaces are `WHERE` clauses, not parameters** — including `supersede`, the one
  write that spans rows the caller was not handed, on ids a model chose.

### The harness
`packages/ai-harness` is domain-agnostic: it knows nothing about orders, prices or
warehouses, and never imports the application (ADR 0020). It ships no controller — routes
need the application's guards — so a whole chat turn (replay → recall → agent → persist →
consolidate) lives in `ChatTurnService` rather than in an HTTP handler.

`OpenAiToolLoopRuntime` runs the tool loop itself against the OpenAI-compatible protocol
LiteLLM serves. It calls the handlers, so it times them, so `tool_start` / `tool_end` are
facts it observes rather than events it hopes an SDK will emit — which is what lets the
console show an operator which tool an answer came from (ADR 0021). It sits behind
`AgentRuntime`; `test/harness/runtime-swappable.spec.ts` runs a whole turn on a replacement.

### Trade-off
Every test here binds a fake gateway, so the suite needs no credential and no budget — but
it also cannot tell you whether a real model, given these tool descriptions, reaches for the
right tool. That gap is covered by the opt-in `apps/web/e2e/copilot-proposal.spec.ts` and
by the Bedrock smoke run, both outstanding until AWS credentials exist (ADR 0003).

Resolving the caller inside each tool call costs one query per call. It buys immediate
effect for a revoked role, and a registry that can list tool names without inventing a
caller to build one.

---

## Interaction Between Invariants

1. **Concurrency ↔ Pricing:** create-order prices the cart (two queries) before any stock row is locked, inside the same transaction. The order stores the prices it charged and never re-reads them (ADR 0011).

2. **Transaction ↔ Outbox:** the `tx: Tx` a use case receives is the transaction that both changes the order and writes its event (ADR 0004, 0017).

3. **Multi-tenant ↔ Outbox:** every `outbox_events` row has a non-null `org_id` (the order's buyer organisation). `audit_log` copies it as NOT NULL, audit reads go through `OrgScope`, and `GET /ops/audit` is `ops_admin`-only (ADR 0019).

4. **Transactions ↔ Concurrency:** the single lock order prevents deadlock. A status change settles the whole order or nothing; there is no intermediate "releasing" state (ADR 0013, 0018).

---

## Related Documentation

- `docs/code-standards.md`: rules for each layer (transactions, money, tenancy, ledger, errors, tests, outbox handlers).
- `docs/adr/index.md`: ADRs 0001–0025.
- `docs/decisions-vs-stockflow.md`: what v2 ports from StockFlow (Go) unchanged, and what it changes on purpose.
- `docs/diagrams/`: components, order creation, outbox relay, copilot flow.
- `scripts/verify-architecture.sh`: grep gates (platform never imports modules, ai-harness never imports apps, copilot never touches SQL, money is never a float, no "releasing" state).
