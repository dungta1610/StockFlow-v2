# Architecture Decision Records (ADRs)

Each ADR records why one part of the system is the way it is. This index gives each ADR's title, status and date exactly as they appear in the file, plus the plan phase that wrote it.

There are 25 ADRs: 0001–0025, contiguous.

## Foundation (Phase 00)

| # | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-modular-monolith-with-ports.md) | Modular monolith with ports | accepted | 2026-09-17 |
| [0002](./0002-single-postgres-two-schemas.md) | One Postgres, two schemas, forward-only migrations | accepted | 2026-09-17 |
| [0003](./0003-bedrock-region-models-and-tool-events.md) | Bedrock region, models, and tool-event observability | accepted; chat/embedding checks **pending** (no AWS credentials), tool events resolved by ADR 0021 | 2026-09-17, rev. 2026-09-20 |
| [0004](./0004-explicit-transaction-boundaries-and-isolation.md) | Explicit transaction boundaries and isolation | accepted | 2026-09-17 |
| [0005](./0005-monorepo-package-consumption-and-tooling.md) | Monorepo package consumption and tooling versions | accepted (amends the planned "source consumption only" approach) | 2026-09-17 |
| [0006](./0006-test-isolation-strategy.md) | Test isolation strategy | accepted | 2026-09-17 |

## Identity, Auth & Multi-Tenancy (Phase 01)

| # | Title | Status | Date |
|---|---|---|---|
| [0007](./0007-org-scope-not-bare-org-id.md) | OrgScope instead of a bare organisation id; memberships | accepted | 2026-09-17 |
| [0008](./0008-defer-postgres-rls.md) | Defer Postgres row-level security | accepted | 2026-09-17 |
| [0009](./0009-refresh-token-transport-and-csrf.md) | Tokens, refresh transport, CSRF and login throttling | accepted | 2026-09-17 |

## Commerce Domain (Phases 02–04)

| # | Title | Phase | Status | Date |
|---|---|---|---|---|
| [0010](./0010-money-as-minor-units-single-currency.md) | Money as integer minor units, one currency | 02 | accepted | 2026-09-18 |
| [0011](./0011-price-resolver-port-without-chain.md) | One price-resolver port, no resolver chain | 02 | accepted | 2026-09-18 |
| [0012](./0012-two-write-mechanisms-for-inventory.md) | Two write mechanisms for stock, and what `version` is not | 03 | accepted | 2026-09-18 |
| [0013](./0013-atomic-reservation-over-pessimistic-lock.md) | Atomic reservation, one transaction per order, one lock order | 04 | accepted; one open question (below) | 2026-09-18 |
| [0014](./0014-order-code-generation.md) | Order codes from a sequence | 04 | accepted | 2026-09-18 |
| [0015](./0015-idempotency-strategy.md) | Idempotency keys: claim first, commit with the work, free on failure | 04 | accepted | 2026-09-18 |
| [0016](./0016-order-lifecycle-without-payment-module.md) | Order lifecycle without a payment module | 04 | accepted | 2026-09-18 |

## Outbox, Scheduler & Audit (Phase 05)

| # | Title | Status | Date |
|---|---|---|---|
| [0017](./0017-transactional-outbox.md) | Transactional outbox: claim by row lock, attempts count failures | accepted | 2026-09-19 |
| [0018](./0018-reservation-expiry-via-order-lock.md) | Reservation expiry: read ids outside a transaction, claim by order lock | accepted | 2026-09-19 |
| [0019](./0019-audit-log-scoping-and-redaction.md) | Audit log: owned, scoped and redacted | accepted | 2026-09-19 |

## Web (Phase 09)

| # | Title | Status | Date |
|---|---|---|---|
| [0025](./0025-spa-over-ssr.md) | The ops console is a plain SPA, not server-rendered | accepted | 2026-09-19 |

## AI Harness (Phase 07)

| # | Title | Status | Date |
|---|---|---|---|
| [0020](./0020-ai-harness-as-package.md) | The AI harness is a package, and it ships no controller | accepted | 2026-09-20 |
| [0021](./0021-agent-runtime-behind-interface.md) | The agent loop is ours, behind an interface | accepted | 2026-09-20 |
| [0022](./0022-memory-namespace-and-session-ownership.md) | Memory namespaces and session ownership are enforced by WHERE clauses | accepted | 2026-09-20 |

## Ops Copilot (Phase 08)

| # | Title | Status | Date |
|---|---|---|---|
| [0023](./0023-agent-tools-call-services-not-repositories.md) | Agent tools call application services, never repositories | accepted | 2026-09-20 |
| [0024](./0024-human-in-the-loop-for-agent-writes.md) | The agent proposes; a person decides | accepted | 2026-09-20 |

---

## Open Questions

### Buyers can read exact stock levels through `INSUFFICIENT_STOCK` (ADR 0013)

When an order fails for lack of stock, `POST /orders` returns `409 INSUFFICIENT_STOCK` with `{ product_id, sku, requested, available }`. `available` is the exact quantity available at that warehouse (`create-order.use-case.ts`, `reserveStock`). Every inventory endpoint is `ops`/`ops_admin`-only, yet a buyer can post an oversized quantity for any product at any warehouse and read the stock level from the error. Nothing changes when the order fails, so this works as a free lookup. The number also reflects other buyers' reservations.

This matches the Phase 04 plan, which specified these fields, so it is a product decision rather than a bug. It has not been decided (Phase 04 code review, finding M1). The options are:
- keep it, and accept the exposure;
- return `available` only to internal ops, or clamp it (for example `min(available, requested - 1)`);
- drop `available` for buyers and keep `sku` and `requested`.

`OrderService.diagnose` computes the same `available` figure but has no HTTP route yet. It has to be decided before any caller exposes it to buyers (for example a copilot tool).

---

## What the Plan Red Team Changed

On 2026-09-17, four adversarial reviewers checked the plan. They raised 39 raw findings, which were merged into 16; all 16 were accepted (12 Critical, 4 High). The full list is in the plan's "Red Team Review" section. The ones that shaped these ADRs:

1. **No intermediate "releasing" state** (finding #1). Expiry used to move reservations to `releasing` inside one sweep-wide transaction, which could strand stock. Now `inventory_reservations.status` is only `held | released | consumed`, and a status change settles the whole order under its row lock (ADR 0013, 0018). This is enforced by the "no releasing" gate in `scripts/verify-architecture.sh`. Tests: `scheduler/expiry-*.spec.ts`, `ordering/no-deadlock-mixed-flows.spec.ts`.
2. **Ops had no read path to buyer data** (finding #2). Scoping by `actor.orgId` left ops staff, who belong to the internal organisation, seeing nothing. Fixed by `OrgScope` (`single` / `all-buyers` / `all`) (ADR 0007). Test: `identity/org-scope.spec.ts`.
3. **Nested transactions and unstated isolation** (findings #5, #6). Use cases take `tx: Tx` and never open one. READ COMMITTED, `lock_timeout` and `statement_timeout` are set per connection (ADR 0004). Tests: `platform/transaction-settings.spec.ts`, `scheduler/no-nested-transaction.spec.ts`.
4. **Tool lifecycle events were assumed, not verified** (finding #4). The reference harness only yielded `textDelta`. This became the ADR 0003 spike question, and was settled in ADR 0021 by removing the dependency: the harness runs its own tool loop and emits the events around handlers it calls itself. Test: `harness/tool-events.spec.ts`.
5. **Outbox had two sources of truth; the audit log crossed tenants** (finding #14). `status` is the only "handled" predicate, and `audit_log` has a NOT NULL `org_id` with a whitelisted summary (ADR 0017, 0019). Tests: `outbox/single-source-of-truth.spec.ts`, `audit/scope.spec.ts`, `audit/redaction.spec.ts`.
6. **The idempotency claim sat inside the order transaction** (finding #16). A rollback erased the key. Now the claim commits first, and a failure frees the key (ADR 0015). Tests: `ordering/idempotency-*.spec.ts`.

The per-event outbox savepoint (ADR 0017) did not come from the red team. It came from the Phase 05 code review (2026-09-19), which found that a handler's SQL error aborted the whole claiming transaction.

### Scope cut

- **Phase 06 (payment) cancelled.** It teaches no chapter's invariant, and its simulated callback had an authentication hole (finding #7). It was replaced by `POST /orders/:id/mark-paid` (ops only) in Phase 04 (ADR 0016).
- **Phase 10 (buyer portal) cancelled.** It adds no new invariant, and what it would show (contract prices, reservations) is already visible in the console.

---

## How to Read This Index

1. **New contributor:** start with 0001–0006 (what the system is), then your area: 0007–0009 for identity, 0010–0016 for commerce, 0017–0019 for outbox and audit.
2. **Code question:** grep the ADRs for the topic (e.g. "money") or the name (e.g. "OrgScope").
3. **Design conflict:** most ADRs have a **Consequences** section listing what the decision costs. Some also record rejected alternatives.
4. **Architecture gates:** `scripts/verify-architecture.sh` and `eslint.config.mjs` enforce some ADR boundaries. `docs/code-standards.md` lists the rules for each layer.

## Tracking Changes

An ADR is never deleted or renumbered. If a later decision overturns one, a new ADR explains why, and the old one is marked superseded with a link to it.
