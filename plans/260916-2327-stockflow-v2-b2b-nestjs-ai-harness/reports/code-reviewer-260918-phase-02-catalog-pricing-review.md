# Code Review: Phase 02, Catalog, Warehouse & Pricing (uncommitted changes)

Date: 2026-09-18 · Reviewer: code-reviewer · Mode: report only (no source, test or doc edits)

## Scope
- Files: `db/migrations/003_catalog.sql`, `004_pricing.sql`; `apps/api/src/modules/{catalog,pricing}/**` (26 files); `apps/api/src/platform/database/sql.ts`; identity refactor (`scope-sql.ts`, `sql-*.repository.ts`, `user.repository.ts`, `identity.module.ts`); `app.module.ts`; `cli/seed.ts`, `cli/seed-catalog.ts`; `packages/contracts/src/{common,catalog,pricing,identity,index}.ts`; tests under `apps/api/test/{catalog,pricing}` plus `test/identity/seed.spec.ts`.
- About 1,500 LOC of source and 870 LOC of tests.
- Checks run:
  - `pnpm lint`: clean.
  - `pnpm typecheck`: clean in all 4 projects.
  - `vitest run test/catalog test/pricing test/identity`: **20 files, 205 tests, all passed** (testcontainers).
  - A throwaway probe spec in the session scratchpad, run against the real app, confirmed finding H1. No repo files were touched.

## Overall Assessment
The code is solid and close to shippable.
- **Tenant isolation holds.** The pricing policy is pure and deterministic, and the resolver makes 2 queries for any cart size.
- **Authorization is layered correctly.** Route `@Roles` sit on top of use-case `assertRole`, and ops roles only count in the internal org.
- **Transactions are correct.** Use cases never open transactions, and the upsert/archive race is handled by `FOR UPDATE`.
- **The sql.ts refactor did not break identity.** All identity tests still pass.

One real functional bug (H1) blocks landing: upper-case UUIDs, which the API accepts, make valid products look missing.

## Critical Issues
None found. I found no path, through any endpoint or error message, that lets one buyer see another buyer's contract price (see section (b)).

## High Priority

### H1. Upper-case product UUIDs are accepted, then reported as `PRODUCT_NOT_FOUND` (verified by running it)
- **Where:**
  - `packages/contracts/src/pricing.ts:24` and `:77` use `z.uuid()`, which accepts upper-case.
  - `apps/api/src/modules/catalog/infrastructure/sql-product.repository.ts:76` keys the map by `r.id`, and Postgres always returns lower-case.
  - `apps/api/src/modules/pricing/infrastructure/sql-price-resolver.ts:48-53,88` and `application/use-cases/price-list.use-cases.ts:65-66` look up `products.get(line.productId)` using the raw request string.
- **What happens:** a client sends `{"items":[{"product_id":"23342A93-1A57-...","qty":1}]}` for a product that exists. The probe output:
  ```
  QUOTE UPPER  404 {"error":{"code":"PRODUCT_NOT_FOUND",...}}
  UPSERT UPPER 404 {"error":{"code":"PRODUCT_NOT_FOUND",...}}
  ```
  The same request with a lower-case id returns 200. `customer_org_id` in upper-case works, because the code uses the id that comes back from the database.
- **Why it matters:**
  - **Phase 04 inherits it.** Carts and orders will call the same resolver.
  - **Duplicate check is bypassed.** The duplicate-tier/duplicate-product `refine` checks (`pricing.ts:31-33`, `:80`) compare raw strings. So `ABC…` and `abc…` both pass. Once the lookup is fixed, a mixed-case upsert will hit `ON CONFLICT DO UPDATE command cannot affect row a second time` (SQLSTATE 21000), which surfaces as a **500**.
  - **Phase 08 inherits it.** Its tools pass model-generated ids.
- **Fix:** normalise at the boundary so the dedupe `refine` sees the same form, e.g. a shared `export const uuidSchema = z.uuid().transform((s) => s.toLowerCase())` in `common.ts`, used everywhere ids are accepted. Also lower-case inside `CatalogService.findProducts` / `SqlPriceResolver`, because use cases are also called by non-HTTP callers (code-standards §5). Add an API test that uses an upper-case id.

## Medium Priority

### M1. The price-list repository and use cases take no `OrgScope` (breaks code-standards §5)
- **Where:** `apps/api/src/modules/pricing/application/ports/price-list.repository.ts:19-24`, `infrastructure/sql-price-list.repository.ts:61-101`.
- **Problem:** price lists are organisation-owned data (a contract belongs to one buyer). Yet `findById`, `findItems` and `list` read any list. Today this is safe only because every use case does `assertRole(actor, 'ops', 'ops_admin')`, and ops' scope is all-buyers anyway.
- **Failure scenario:** Phase 08 or a buyer portal adds "show my contract". A developer reuses `GetPriceListUseCase` with a relaxed role check, or calls the repository directly. A buyer then gets any list by id, including another buyer's contract prices. The type system does not stop this, which is exactly what ADR 0007 exists to prevent.
- **Fix:** pass `OrgScope` to `findById`, `findItems` and `list`. Apply `scopeSql` to `(l.org_id, l.org_type)` and let default lists (`org_id IS NULL`) through explicitly. The use cases pass `orgScopeOf(actor)`.

### M2. Re-posting a tier changes its price in place, which contradicts ADR 0011
- **Where:** `sql-price-list.repository.ts:108-113` (`ON CONFLICT … DO UPDATE SET unit_price = EXCLUDED.unit_price`).
- **Conflict:** ADR 0011 says "Price lists are archived, never deleted, so an order line can always point at the tier that priced it." Yet the tier row that `source_id` points at can have its `unit_price` changed later.
- **Failure scenario (Phase 04):** an order line stores `source_id = X` at 48000. Ops re-posts the tier at 45000. The audit or copilot explanation ("priced from tier X") now shows a price that differs from the one charged.
- **Fix, pick one:**
  - (a) Make tiers immutable: on conflict, insert a new row and mark the old one superseded (needs a `superseded_at` column and a partial unique index).
  - (b) Require order lines to snapshot `unit_price`/`min_qty`, and correct the ADR wording so it does not promise that the tier explains the price.

  Decide before Phase 04 writes the FK.

### M3. The money grep gate is case-sensitive and misses a JS `number` money field in `apps/api/src`
- **Where:** `apps/api/src/cli/seed-catalog.ts:8` (`basePrice: number`) and `:80` (`priceAt(base: number, …)`).
- **Problem:** the success criterion "grep ⇒ empty" passes only because `basePrice` has a capital `P`. `grep -i` finds the line. The seed arithmetic happens to be integer-only today (`Math.round(...) * 100`), so no wrong prices are produced now. But ADR 0010 and code-standards §4 promise that no money is a JS number, and the gate as written would not catch `unitPrice: number` in Phase 04 either.
- **Fix:**
  - Make the seed prices decimal strings and compute tier prices with `Money`, e.g. `Money.parse(base).minor * BigInt(percent)`, then round in bigint.
  - Make the gate case-insensitive: `grep -rniE "(price|amount|total|subtotal)\s*:\s*number"`.

## Low Priority

- **L1. Use-case input errors become 500 for non-HTTP callers.**
  - **Where:** `pricing/domain/money.ts:24-26`, `:33`.
  - **Problem:** `Money.parse` throws a plain `Error`. The same goes for an SKU that is all whitespace, or for `minQty < 1` passed to the use cases directly: they hit a DB CHECK and fail with 23514. Zod shields the HTTP routes, but code-standards §5 says jobs and agent tools call use cases directly, and those calls would get 500 instead of 400.
  - **Fix:** have `Money.parse` throw `badRequest('INVALID_AMOUNT', …)`, and validate `minQty`/code in the use cases.
- **L2. Two-way dependency between catalog and pricing.**
  - **Where:** `catalog/domain/catalog.ts:1`, `catalog.repositories.ts:3`, and `sql-product.repository.ts:10` import `pricing/domain/money`, while pricing imports `CatalogService`/`CatalogErrors`.
  - **Impact:** this is not a Nest DI cycle, but it is a module-level cycle.
  - **Fix:** move `Money` to a shared kernel, e.g. `modules/shared/domain/money.ts`.
- **L3. Identity now exports its whole repository.**
  - **Where:** `identity.module.ts` exports `OrganizationRepository`, including `create`, to other modules.
  - **Problem:** catalog deliberately exposes only a narrow `CatalogService`. Identity should do the same.
  - **Fix:** a narrow `OrganizationDirectory.findInScope(db, scope, id)`.
- **L4. Seed idempotency depends on list names.**
  - **Where:** `seed-catalog.ts:106-109`.
  - **Problem:** a price list created in the UI with the same name and owner makes `rows[0]` arbitrary. A seed list that was archived is silently reused. `base_price` and tier prices are never refreshed on re-run (`DO UPDATE SET name` / `DO NOTHING`).
  - **Impact:** re-running the seed does not create duplicates, which the test confirms. This is dev-only, so it is acceptable if documented.
- **L5. Quotes read without a shared snapshot.**
  - **Where:** `quote.controller.ts:23-32`.
  - **Problem:** three autocommit reads (org, products, tiers), so there is no snapshot across them. This is harmless for a quote.
  - **Watch for:** Phase 04 must call the resolver with its `tx`, or a price and the stock check can come from different snapshots.
- **L6. Line totals can exceed what the database can store.**
  - **Where:** `Money.times` is unbounded.
  - **Problem:** qty ≤ 1e6 × price ≤ 1e16 exceeds `numeric(18,2)`. Quotes are fine, but when Phase 04 persists `line_total`, the database will raise 22003, which surfaces as a 500.
  - **Fix:** add a range check at persistence.

## (a) Success criteria check

| Criterion | Holds? | Evidence |
|---|---|---|
| 12 spec tests green (7 files) | Yes | Suite run: money, pick-price (tiers 1/49/50/199/200/1000, selection, 50-iteration determinism), price-resolver (source kind, query count, scope, isolation), pricing-constraints (VND CHECK), products/warehouses API, lookups (`warehouses-api.spec.ts:81-105`) |
| Same query count for 1 and 20 lines, ≤ 2 | Yes | `price-resolver.spec.ts` "same small number of queries"; the code runs exactly 2 (`findByIds` plus the tier query) |
| Buyer A and buyer B get different prices in the seed | Yes | `seed.spec.ts` compares MARKER-WB-02 at min_qty 1 (85500 vs 83600) |
| Ops can price for any buyer; a buyer cannot price for another org | Yes | Resolver scope tests plus API quote tests (404, no leaked price) |
| Product outside every list falls back to `base_price` without an error | Yes | Resolver test (SKU-3) |
| Money grep gate returns nothing | **Only literally** | See M3 (`-i` finds `seed-catalog.ts:8`) |
| DB rejects currency other than VND | Yes | `pricing-constraints.spec.ts:6` |
| No `chain-price-resolver.ts` | Yes | Not present |
| ADR 0010 and 0011 exist and 0011 explains dropping the chain | Yes | Read |

H1 is not covered by any criterion, but it contradicts the intent of "Product outside every list ⇒ base_price, no error": a valid product returns 404.

## (b) `pickPrice` / `SqlPriceResolver`
- **Tier choice:** tiers are filtered to `minQty <= qty` before a list is chosen. So when a contract has no tier small enough, the price falls through to the default list, which the tests cover and ADR 0011 documents. Within the chosen list, the largest tier wins; ties are impossible because of the UNIQUE constraint.
- **Validity window:** `valid_from <= at < valid_to`, applied in both SQL and JS. JS `Date` has only millisecond precision, while Postgres stores microseconds; values written through the API are millisecond-precise, so this is not reachable in practice.
- **Determinism:** the ordering is total (contract, then priority, then valid_from, then list id), so results never depend on row order.
- **Order of checks:** `assertOrgInScope` and quantity validation run before any query. `QuotePricesUseCase` first loads the org with a scoped query, so an out-of-scope org and a missing org both return the same `NOT_FOUND`. There is no existence oracle.
- **Isolation:**
  - The SQL filters `org_id = customer.id OR NULL`, and `pickPrice` filters again.
  - `customer.id` always comes from the database row, never from the request.
  - Error messages only include the requester's own SKU (`PRODUCT_INACTIVE`).
  - `/price-lists` is ops-only in both the route decorators and the use cases.
  - **No leak path found.** Remaining risk is future reuse (M1).

## (c) Authorization
- **`/products` and `/warehouses`:**
  - Reads have no role requirement, by design (any signed-in user).
  - Writes require `@Roles('ops_admin')` on the route **and** `assertRole('ops_admin')` in the use case. Tests confirm that buyer and ops callers get 403.
- **`/price-lists`:** the class-level `@Roles('ops','ops_admin')` is overridden on write methods by `@Roles('ops_admin')` (the guard uses `getAllAndOverride`). Every use case repeats the check, with the internal-org rule. An ops-role holder in a buyer org is not possible (role/org-type constraint), and `assertRole` would reject one anyway.
- **`/pricing/quote`:** no route decorator. The use case allows the four roles, and a buyer is always pinned to their own organisation by the scoped query.
- No gaps found.

## (d) Concurrency and transactions
- **Upsert vs archive:** upsert takes `SELECT … FOR UPDATE` and then checks status; archive is an `UPDATE`, which also takes the row lock. Under READ COMMITTED, either order serialises correctly (an upsert that waited sees `archived` and returns 409).
- **Concurrent upserts:** two upserts on the same list serialise on that lock, and `ON CONFLICT` covers the rest.
- **Race on the buyer-only rule:** create-price-list checks the org type in the application, and the composite FK plus `chk_price_list_owner` enforce it in the database.
- **Unique-violation mapping:** the constraint names `products_sku_key` and `warehouses_code_key` match Postgres defaults and are covered by the 409 tests.
- **Only open issue:** the case-variant duplicate described in H1.

## (e) Money and SQL safety
- **Money parsing:**
  - `Money.parse` accepts `^\d{1,16}(\.\d{1,2})?$` and rejects numbers and signs.
  - `fromDb` handles trailing zeros and signs.
  - `toString` pads correctly, including for negative values.
  - `times` accepts only safe integers.
  - The DB never returns floats, and a test round-trips `9999999999999999.99`.
- **SQL:** every query is parameterised. `escapeLike` escapes `\ % _`, and the default ILIKE escape character is `\`. There is a test for literal wildcards. The only string interpolation is of fixed column lists and the `FOR UPDATE` literal.

## (f) Phase 01 regressions from the sql.ts extraction
None. `pagingSql`, `isUniqueViolation` and `escapeLike` are byte-for-byte moves. `paramBinder` has the same semantics as the inline `bind` it replaces. `Paging` is re-exported from `user.repository.ts`, so existing imports still compile. `platform/` does not import `modules/` (lint is clean). All identity specs pass.

## (g) Seed idempotency
Running the seed twice leaves the same counts, which is tested. Orgs, products and warehouses are keyed by code; price lists by name and owner; tiers by the unique key. See L4 for the edge cases.

## (h) Lint, type and build
`pnpm lint` and `pnpm typecheck` are clean; build was not run separately. The phase file is already marked `status: completed` although H1 is still open.

## Positive Observations (for risk calibration)
- The composite FK `(org_id, org_type)` plus the CHECK makes "contract only for buyers" a database invariant, not just a code check.
- The resolver returns results in request order, and a missing product fails the whole call instead of being silently dropped. This is the safer contract for ordering.

## Recommended Actions
1. **H1:** lower-case UUIDs at the contract boundary and in the resolver/catalog lookup. Add an API test with an upper-case id, including the mixed-case duplicate upsert.
2. **M2:** decide tier immutability vs price snapshot before Phase 04 adds the `source_id` FK, and fix the ADR 0011 wording.
3. **M1:** add `OrgScope` to the price-list repository reads.
4. **M3:** use string/`Money` for seed prices and make the grep gate case-insensitive.
5. L1–L6 as time allows. L5 and L6 matter in Phase 04.

## Metrics
- Type coverage: strict tsc passes. The only `any`-like widening is the cast to `{ code?; constraint? }` in `sql.ts`.
- Tests: 205 tests pass across catalog, pricing and identity. No coverage report was run.
- Lint issues: 0.

## Unresolved Questions
- M2: should order lines reference an immutable tier, or snapshot the price? This is a product/audit decision for the lead.
- Should buyers see inactive products and `base_price` through `GET /products`? The current code allows it on purpose; please confirm this is the intended product behaviour.
