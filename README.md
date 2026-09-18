# StockFlow v2

A learning project: a B2B e-commerce backend on NestJS that exercises concurrency invariants, eventual consistency and (planned) an agent that works through domain tools. The frontend is a React SPA used by ops staff and by buyer organisations to manage orders, inventory and pricing.

**Status:** Phases 01–05 are complete (identity, catalog and pricing, inventory, ordering, outbox and audit). Phase 09 (web console) is in progress. Phase 00 is done except the Bedrock spike, which waits for AWS credentials; the AI phases 07–08 depend on it and have not started. Phases 06 (payment) and 10 (buyer portal) were cancelled.

## Architecture at a Glance

Five invariants, one lesson each:

| Invariant | Lesson | Code |
|---|---|---|
| No oversell | Atomic conditional update + one lock order | `apps/api/src/modules/ordering/application/use-cases/create-order.use-case.ts` |
| Prices come from the server only | Port + pure policy function, never client input | `apps/api/src/modules/pricing/` |
| One outbox, many consumers | Transactional outbox, claim by row lock, savepoint per event | `apps/api/src/platform/outbox/` |
| Multi-tenant without leaks | `OrgScope` in signatures, not "if admin skip filter" | `apps/api/src/modules/identity/domain/org-scope.ts` |
| Agent ≤ user privilege | Tools built per actor; tools call application services | not built (Phases 07–08) |

See `docs/system-architecture.md` for the full picture.

---

## Quickstart

### Prerequisites

- Node.js 22+
- pnpm 9.15.9 (`packageManager` in `package.json`)
- Docker Desktop (or `docker` + `docker compose`)

### 1. Install

```bash
git clone <repo>
cd <repo>
pnpm install
cp .env.example .env
```

Compose reads `.env` for its `${VAR}` defaults (host ports, `SEED_PASSWORD`, `JWT_SECRET`, …). Every published port is bound to `127.0.0.1`.

### 2a. Run everything in Docker

```bash
docker compose up -d --build
docker compose ps
```

This starts:

| Service | Host port (`.env` variable) | Notes |
|---|---|---|
| `postgres` (pgvector, PG 16) | `5433` (`POSTGRES_PORT`) | |
| `redis` | `6380` (`REDIS_PORT`) | |
| `litellm` | `4001` (`LITELLM_PORT`) | Starts without AWS credentials; model calls fail until `AWS_*` is set. The API does not use it yet. |
| `migrate` | — | One-shot: applies `db/migrations`, then seeds demo data when `SEED_ALLOW=true` (the default), then exits. |
| `api` | `3100` (`API_PORT`) | Waits for `migrate` to succeed. Uses `JWT_SECRET` from `.env`, or a dev-only placeholder when it is empty. |
| `web` (nginx) | `8080` (`WEB_PORT`) | Built SPA; calls the API at `http://localhost:3100`. |

Open `http://localhost:8080`. Long-running services should report `healthy`; `migrate` shows as exited.

### 2b. Or run the API and web on the host (dev mode)

Start only the infrastructure, then run the migrations, seed and apps from the host. The API reads the root `.env`.

```bash
# JWT_SECRET is required on the host (at least 32 characters). Generate one and paste it into .env:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

cp apps/web/.env.example apps/web/.env       # VITE_API_URL=http://localhost:3100

docker compose up -d postgres redis
pnpm --filter @stockflow/contracts build     # the API runs against the built contracts package (ADR 0005)
pnpm migrate                                 # applies db/migrations
pnpm seed                                    # demo data; refuses unless SEED_ALLOW=true (set in .env.example)

pnpm dev:api    # http://localhost:3100 (PORT in .env)
pnpm dev:web    # http://localhost:5173
```

Do not run 2a and 2b together: the compose `api` service and `pnpm dev:api` both use host port 3100.

**Health check:**
```bash
curl http://localhost:3100/health
# {"status":"ok","checks":{"database":"up","redis":"up"}}   (503 and "down" if either check fails)
```

### Demo Accounts

Created by the compose `migrate` service, or by `pnpm seed`. Environment variable: `SEED_PASSWORD` (default: `ChangeMe-123!`).

Defined in `apps/api/src/cli/seed.ts`.

| Email | Org | Role | Can do |
|---|---|---|---|
| `ops.admin@stockflow.local` | INTERNAL | ops_admin | everything ops can, plus catalog/pricing writes, users, audit and outbox views |
| `ops@stockflow.local` | INTERNAL | ops | every buyer's orders, inventory, reservations; order lifecycle actions |
| `admin@buyer-a.local` | BUYER-A | buyer_admin | BUYER-A orders and users |
| `buyer@buyer-a.local` | BUYER-A | buyer | place and view BUYER-A orders |
| `admin@buyer-b.local` | BUYER-B | buyer_admin | BUYER-B orders and users |
| `distributor@stockflow.local` | BUYER-A + BUYER-B | buyer | two memberships: login asks which org to act as |

Buyers never see inventory levels or other organisations' data through the inventory screens and endpoints. One known exception: a failed order returns `409 INSUFFICIENT_STOCK` with the `available` quantity (see ADR 0013). Log in at `/login` on the web app (`http://localhost:8080` in Docker, `http://localhost:5173` in dev mode).

---

## Running Tests

The API tests start their own Postgres and Redis containers (testcontainers), so Docker must be running. They do not use the compose stack.

```bash
# API integration tests
pnpm test

# Watch mode
pnpm --filter @stockflow/api test:watch

# One file (the argument is a vitest filter)
pnpm test ordering/no-oversell-concurrent.spec.ts

# Web unit tests
pnpm --filter @stockflow/web test

# Web end-to-end tests (Playwright). Needs the API and web app already running;
# see apps/web/playwright.config.ts for E2E_BASE_URL / E2E_API_URL.
pnpm --filter @stockflow/web test:e2e
```

Test files run one at a time. Every test starts from truncated tables and a flushed Redis (ADR 0006).

### Critical tests

- `ordering/no-oversell-concurrent.spec.ts`: 50 concurrent orders for 10 units. Exactly 10 succeed and exactly 40 get `INSUFFICIENT_STOCK`, repeated over 10 runs in one suite run.
- `ordering/no-deadlock-crossing.spec.ts`, `ordering/no-deadlock-mixed-flows.spec.ts`: order and stock paths running concurrently never deadlock.
- `outbox/*.spec.ts`: two relays claiming at once, crash after claim, SQL failure mid-batch, retry backoff, dead events, idempotent handlers.
- `pricing/price-resolver.spec.ts`: resolving prices takes at most 2 queries, and the same number for 1 line as for 20.

To check the concurrency test for flakiness:
```bash
for i in {1..10}; do pnpm test no-oversell-concurrent || exit 1; done
```

---

## Architecture Verification

```bash
# Grep gates (bash): platform never imports modules, ai-harness never imports apps,
# copilot never touches SQL, money is never a float, ordering has no 'releasing' state
scripts/verify-architecture.sh

# TypeScript check (all workspace packages)
pnpm typecheck

# ESLint (also enforces the import boundaries in eslint.config.mjs)
pnpm lint

# Prettier. Rewrites files in place.
pnpm format
```

See `scripts/verify-architecture.sh` for the 5 gates and `docs/code-standards.md` for the rules they protect.

---

## Project Layout

```
apps/api/
├── src/
│   ├── platform/          # Mechanism: config, database, errors, health, http, observability,
│   │                      #   outbox, ratelimit, redis, scheduler, validation
│   ├── modules/           # Business: identity, catalog, inventory, ordering, pricing, audit
│   │   └── {module}/
│   │       ├── domain/          # Entities, errors, pure rules (no I/O)
│   │       ├── application/     # Use cases, services, ports
│   │       ├── infrastructure/  # SQL implementations of the ports
│   │       └── http/            # Controllers and presenters
│   ├── cli/               # migrate and seed entry points (used by the container and by scripts/)
│   └── main.ts            # App entry
├── test/                  # Integration tests (testcontainers)
└── Dockerfile

apps/web/
├── src/
│   ├── components/        # UI primitives
│   ├── features/          # Pages per area: orders, inventory, catalog, pricing, orgs, users, audit, auth
│   ├── lib/               # API client, auth store, hooks
│   ├── app-layout.tsx     # Main layout
│   └── router.tsx         # Routes
├── test/                  # Vitest unit tests
├── e2e/                   # Playwright tests
├── nginx.conf
└── Dockerfile

packages/
├── contracts/             # Zod request/response schemas shared by the API and the web app
└── ai-harness/            # Empty placeholder for Phase 07

db/migrations/
├── 001_schemas.sql        # `commerce` and `ai` schemas; vector and citext extensions
├── 002_identity.sql       # organizations, users, org_members, refresh_tokens
├── 003_catalog.sql        # products, warehouses
├── 004_pricing.sql        # price_lists, price_list_items
├── 005_inventory.sql      # inventory, inventory_transactions (ledger)
├── 006_ordering.sql       # orders, order_items, inventory_reservations, outbox_events, idempotency_keys
└── 007_outbox_audit.sql   # audit_log

docs/
├── system-architecture.md     # Five chapters: concurrency, pricing, outbox, multi-tenancy, agent (planned)
├── code-standards.md          # Rules per layer
├── decisions-vs-stockflow.md  # What changed from the Go repo, and why
├── adr/                       # 20 ADRs: 0001–0019 and 0025; 0020–0024 reserved for Phases 07–08
└── diagrams/                  # Mermaid: components, order creation, outbox relay, copilot (planned)

scripts/
├── migrate.ts             # pnpm migrate: loads .env, runs apps/api/src/cli/migrate
├── seed.ts                # pnpm seed: loads .env, runs apps/api/src/cli/seed
├── spike-bedrock.mts      # pnpm spike:bedrock: the Phase 00 Bedrock spike
└── verify-architecture.sh # Grep gates

.env.example               # Documented template
docker-compose.yml         # postgres, redis, litellm, migrate (one-shot), api, web
```

---

## What We Deliberately Did Not Build (and Why)

### Payment integration

**Phase 06 was cancelled** after the red-team review of the plan (2026-09-17). It teaches no invariant that ordering does not already teach: idempotency and the state machine are in ordering, and port/adapter is in pricing. Its simulated payment callback also had an authentication problem. Instead, ops record payment with `POST /orders/:id/mark-paid` (roles `ops`, `ops_admin`). Orders have a `paid_at` timestamp, but there is no payment table, gateway or webhook receiver (ADR 0016).

### Buyer portal

**Phase 10 was cancelled.** It adds no new invariant. Buyers sign in to the same web console: they can place and view their own organisation's orders, and buyer admins can manage their users. There is no separate buyer-facing portal.

### Multi-currency

**v1 has one currency, VND**, enforced by `CHECK (currency = 'VND')` on `products`, `price_lists` and `orders`. A `currency` column that nothing checks would be worse than none, because sums across currencies would fail mid-transaction instead of at the edge. Adding currencies means dropping the `CHECK`, adding a currency to `Money` and refusing arithmetic across currencies (ADR 0010).

### Postgres RLS

**Not in v1** (ADR 0008). Tenancy is enforced in the repositories through `OrgScope`. Why: with a shared pool, a forgotten or leaked `SET LOCAL` is itself a cross-tenant bug. The ops "every buyer" scope would make the policies conditional. And every read path already takes a required scope and has isolation tests. Revisit if other services or tools start querying the database directly.

### AI harness and ops copilot (Phases 07–08)

**Not started.** They depend on the Phase 00 Bedrock spike (`pnpm spike:bedrock`, ADR 0003). The spike has not run because no AWS credentials are configured. It must record three facts: whether the chat model answers, the embedding dimension (this fixes `vector(N)`), and whether the Strands SDK's `agent.stream()` surfaces tool-call lifecycle events. If it does not, the harness needs its own tool loop (about 2–3 days, already budgeted) instead of mapping SDK events (about half a day). The design lives in the Phase 07–08 plans. ADRs 0020–0024 are reserved for it.

---

## Key Decisions

See `docs/adr/` for the full rationale. Quick reference:

| ADR | Decision |
|---|---|
| [0004](docs/adr/0004-explicit-transaction-boundaries-and-isolation.md) | Use cases take `tx: Tx` and never open transactions. READ COMMITTED; `lock_timeout` 5s and `statement_timeout` 15s per connection. |
| [0007](docs/adr/0007-org-scope-not-bare-org-id.md) | Services take an `OrgScope` (`single` \| `all-buyers` \| `all`), never a bare organisation id. |
| [0010](docs/adr/0010-money-as-minor-units-single-currency.md) | Money is `numeric(18,2)` in the database, a `bigint` of minor units in the API and a decimal string on the wire. Never a JS `number`. |
| [0013](docs/adr/0013-atomic-reservation-over-pessimistic-lock.md) | Atomic conditional UPDATE, one lock order (orders → reservations → inventory), one transaction per order. |
| [0015](docs/adr/0015-idempotency-strategy.md) | Idempotency-Key: claim first (its own commit), do the work in the order transaction, free the key on failure. |
| [0017](docs/adr/0017-transactional-outbox.md) | Outbox claim by row lock + `SKIP LOCKED`, savepoint per event, attempts count failures. |

---

## Database

Postgres 16 with the pgvector extension. pgvector is reserved for the planned AI phases; nothing uses it yet.

**Manual query on the local stack:**
```bash
psql postgres://stockflow:stockflow@localhost:5433/stockflow
```

**Applied migrations:**
```sql
SELECT name, checksum, applied_at FROM public.schema_migrations ORDER BY name;
```

Application tables live in the `commerce` schema, which the API puts first on its `search_path`.

---

## Troubleshooting

### API refuses to start: "Invalid environment variables"

The environment is validated at boot. A common cause is `JWT_SECRET` being missing or shorter than 32 characters in `.env` (dev mode). Generate one:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Port already in use

The defaults avoid 5432/6379/4000, but you can change `POSTGRES_PORT`, `REDIS_PORT`, `LITELLM_PORT`, `API_PORT` and `WEB_PORT` in `.env`. If you change `POSTGRES_PORT` or `REDIS_PORT`, update `DATABASE_URL` and `REDIS_URL` to match. Do not run the compose `api` service and `pnpm dev:api` at the same time.

### API cannot reach Postgres or Redis

```bash
docker compose ps
docker compose logs postgres
curl http://localhost:3100/health   # shows which check is "down"
```

In dev mode, `DATABASE_URL` and `REDIS_URL` in `.env` must use the host ports (`localhost:5433`, `localhost:6380`).

### Tests are slow the first time

testcontainers pulls `pgvector/pgvector:0.8.1-pg16` and `redis:7.4-alpine` on the first run. Timeouts are set in `apps/api/vitest.config.ts` (60 s per test, 180 s per hook).

### Web app cannot reach the API (CORS or refresh errors)

The web origin must be listed in the API's `CORS_ORIGINS` (default `http://localhost:5173,http://localhost:8080`). In dev mode, `apps/web/.env` must point `VITE_API_URL` at the API (`http://localhost:3100`). Both must be on the same site (for example both on `localhost`), or the `SameSite=Strict` refresh cookie is not sent.

---

## Development Workflow

1. Branch: `git checkout -b feature/name`
2. Change code in `apps/api/src/modules/{name}`, `apps/web/src/` or `packages/contracts/src/`.
3. Write tests alongside the code. Invariants are tested against real Postgres, never mocks (ADR 0006).
4. Run locally (dev mode, see 2b): `pnpm dev:api` and `pnpm dev:web`.
5. Check:
   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm --filter @stockflow/web test
   scripts/verify-architecture.sh
   ```
6. Commit with a conventional message, e.g. `git commit -m "feat: order creation holds stock atomically"`.

See `docs/code-standards.md` for module boundaries and layer rules.

---

## Deployment

Not in scope for v1. The API and web app each have a Dockerfile:

- **API:** Node 24 image. Needs Postgres and Redis. Migrations run from the same image (`node dist/cli/migrate.js`), as the compose `migrate` service shows.
- **Web:** a static SPA built into `apps/web/dist/` and served by nginx in the image. `VITE_API_URL` is fixed at build time.

---

## Learning Goals

1. **Concurrency** (Phases 03–04): atomic conditional updates, one lock order, and proving "no oversell" with 50 concurrent orders.
2. **Pricing** (Phase 02): a price-resolver port with a pure `pickPrice` policy, contract tiers, and server-side prices only.
3. **Outbox** (Phase 05): transactional outbox, claim by row lock, savepoint per event, idempotent handlers.
4. **Multi-tenancy** (Phase 01): `OrgScope` in every service signature; role ↔ organisation type enforced by a database constraint.
5. **Agent safety** (Phases 07–08, not built): tools built per actor, tools call application services, observable tool events.

Chapters 1–4 are implemented and covered by integration tests against real Postgres. Chapter 5 is a design only. See `docs/system-architecture.md` and `docs/adr/`.

---

## References

- **System architecture:** `docs/system-architecture.md`
- **Code rules:** `docs/code-standards.md` (10 sections)
- **Decisions:** `docs/adr/index.md` (ADRs 0001–0019 and 0025)
- **vs. the Go version:** `docs/decisions-vs-stockflow.md`
- **Diagrams:** `docs/diagrams/*.mmd`
