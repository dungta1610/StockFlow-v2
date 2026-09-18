# Code Standards

Rules that the compiler cannot enforce. Each one exists because breaking it causes a
specific failure; the failure is named next to the rule.

## 1. Module layout

Business modules live in `apps/api/src/modules/<name>/` and keep the four layers that
StockFlow (Go) used:

| Layer | StockFlow (Go) | Contains |
|---|---|---|
| `domain/` | `model/` | Entities, value objects, errors, pure rules. No I/O. |
| `application/` | `biz/` | Use cases and **ports** (narrow interfaces per use case). |
| `infrastructure/` | `storage/` | Handwritten SQL implementing the ports. No ORM. |
| `http/` | `transport/gin/` | Controllers and request/response DTOs. |

## 2. Dependency boundaries (enforced by `eslint.config.mjs`)

| Rule | Why |
|---|---|
| `platform/` never imports `modules/` | `platform/` is mechanism (pool, limiter, relay runner). Policy — which event triggers which handler, what a job does — lives in `modules/`. Mixing them makes `platform/` impossible to reuse or test alone. |
| `modules/copilot/` never imports `pg` or any `infrastructure/` | The agent must reach data through the same guarded application services as HTTP controllers. A direct query skips authorization. |
| `packages/ai-harness/` never imports the application | The harness is a domain-agnostic library; the day it knows about orders it can no longer be split out. |

**Never generate SQL from model output (no text-to-SQL), under any circumstances.**

## 3. Transactions (docs/adr/0004)

- Use cases receive `tx: Tx` as a parameter. **A use case never calls `withTransaction`.**
- The caller that owns the unit of work opens the transaction: a controller (one request =
  one transaction) or a job (one unit of work = one transaction).
- No implicit propagation, no AsyncLocalStorage, no nested savepoints.
  *Failure it prevents:* a use case opening its own transaction while its caller holds one
  runs on a second connection, waits on locks the first connection holds, and hangs —
  invisible to Postgres' deadlock detector because one edge of the cycle is in the app.
- Every connection runs with `lock_timeout` and `statement_timeout`; transactions default to
  READ COMMITTED.
- The one exception is `IdempotencyService` (ADR 0015): its key claim must commit before
  the work's transaction opens, so it opens its own transactions and is called only from
  outside one.
- **One lock order for the whole system** (ADR 0013):
  `orders` (by id) → that order's `inventory_reservations` → `inventory` (by product id).
  A path that changes an order locks the order row first; stock rows are always touched
  in product-id order. *Failure it prevents:* two paths taking the same rows in opposite
  order deadlock, and one of them is aborted.
- Every change to an order's status writes its `outbox_events` row in the same
  transaction, with the buyer organisation as `org_id`.

## 4. Money

- Postgres: `numeric(18,2)`. Application: integer minor units. **Never a JS `number` with a
  fractional part for money**, in the API, the web app, or `packages/contracts`.
- v1 has a single currency, enforced by a `CHECK` constraint.
- Amounts cross the API as decimal strings (`moneySchema`, `"65000.50"`); inside the API
  they are `Money` values, built only with `Money.parse` (input) or `Money.fromDb`
  (`numeric` columns). See ADR 0010.
- Prices a buyer pays come only from `PriceResolver`; a price in a request body is ignored.
  See ADR 0011.

## 5. Tenancy

- Services that read organisation-owned data take an `OrgScope`, never a bare `orgId`.
- **Use cases check the caller's role themselves** (`assertRole`). `@Roles` on a route is
  an extra layer, not the only one: jobs and agent tools call use cases without HTTP.
- Use case `execute` methods are `async`, so every failure is a rejected promise — never a
  synchronous throw that a `.catch()` caller would miss.
- Never trust an organisation id that arrives in a request body or in model output.
- Cross-tenant reads return **404**, not 403 (403 confirms the resource exists).

## 6. Ledger

- `inventory_transactions` is append-only: repositories expose no update or delete.
- Every change to `inventory` writes a ledger row in the same transaction — including
  the seed.
- Stock moves only through `StockMovementService`, which writes the movement and its
  ledger row together; the inventory repositories are module-internal.
- Stock moves through single conditional statements that return the levels before and
  after; a primitive returning `null` means the condition did not hold and **nothing
  changed**. `version` is an audit counter, not an optimistic lock (ADR 0012).

## 7. Errors and responses

- Modules throw `DomainError` (stable `code` + HTTP status); they never build responses.
- Every failure renders as `{ error: { code, message, details? } }`.
- Internal error messages are logged, never returned to clients.
- API responses never include password hashes or token material.

## 8. Tests

- Integration tests run against real Postgres and Redis (testcontainers). Invariants are
  never tested against mocks — a mock hides exactly what the test must prove.
- Test files run one at a time; every test starts from truncated tables and a flushed Redis.
- Concurrency tests assert **outcome counts** (e.g. exactly 10 successes and 40 conflicts),
  not only an aggregate invariant: an aggregate can also hold when every request failed.

## 9. Outbox handlers (docs/adr/0017)

- An `OutboxHandler` runs inside the same transaction the relay uses to mark its
  event processed, and **must be idempotent**: at-least-once delivery means
  `handle()` can be called more than once for the same event (a retry, or an
  operator re-running a dead event). State how idempotency is achieved next to the
  handler. The standard shape is a unique key on the write plus
  `ON CONFLICT (...) DO NOTHING` — see `AuditLogHandler`.
- Routing (which event type goes to which handler) lives in `modules/`, registered
  with the relay via `OutboxRelay.registerHandler()`. The relay itself
  (`platform/outbox`) never knows which event types exist.

## 10. Naming

- Files: kebab-case (`create-order.use-case.ts`).
- Migrations: `NNN_description.sql`, contiguous, never renumbered or edited after running
  anywhere (the runner stores checksums and refuses edited files).
- Comments explain the invariant or the reason, never a plan phase or ticket id.
