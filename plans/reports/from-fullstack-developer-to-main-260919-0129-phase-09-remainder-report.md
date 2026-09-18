# Phase 09 remainder: Reservations, audit timeline, e2e, dropdown-cap fix

Scope: everything in phase-09 not already landed in waves 1-4, excluding Copilot/SSE (phases 07/08, still deferred). Read the plan, the waves 2-4 review report, and the freshly landed audit/outbox module (phase 05) before starting.

## 1. Reservations screen

**Backend (`GET /orders?expires_within_minutes=N`)**
- `packages/contracts/src/ordering.ts`: `listOrdersQuerySchema` gains `expires_within_minutes` (1-10080, i.e. up to 7 days). A `.refine` rejects it combined with any `status` other than `reserved`; a `.transform` implies `status=reserved` when `status` is absent, so the caller never has to say both.
- `apps/api/src/modules/ordering/domain/order.ts`: `OrderFilter.expiresWithinMinutes?: number` (needed by the port/repository signature I own; this file isn't in the explicit ownership list but is a direct dependency of it, not touched by the parallel agent).
- `apps/api/src/modules/ordering/http/order.controller.ts`: passes the new field through.
- `apps/api/src/modules/ordering/infrastructure/sql-order.repository.ts` — **`list()` method only**, nothing else in the file touched: adds `reservation_expires_at <= now() + make_interval(mins => $n)` to the WHERE clause and switches `ORDER BY` to `reservation_expires_at ASC, id ASC` only when the filter is present; otherwise identical to before.
- **No new migration.** `idx_orders_reserved_expiry ON orders (reservation_expires_at) WHERE status = 'reserved'` (migration 006) already matches this query's WHERE and ORDER BY exactly. Verified with `EXPLAIN`:
  ```
  Index Scan using idx_orders_reserved_expiry on orders o
    Index Cond: ((reservation_expires_at IS NOT NULL) AND (reservation_expires_at <= (now() + '00:15:00'::interval)))
  ```
  No sequential scan, no new index. **Migration 008 was not created** — the ai_memory migration the plan reserved that number for is unaffected; there is nothing to shift.
- Tests: `apps/api/test/ordering/reservations-filter.spec.ts` (5 tests, all green) — window correctness (soonest/most-overdue first), the `status=reserved` implication, the 400 on `status=paid` + the filter together, and OrgScope (buyer sees only their own, ops sees both).
- Did not touch `listReservedExpired`/the sweep, `reservation.repository.ts`, or `reservation-expiry.job.ts` (the parallel agent's files). Re-read `sql-order.repository.ts` immediately before editing; it was unchanged from my first read.

**Frontend (`/reservations`, ops only)**
- `apps/web/src/features/orders/reservations-list-page.tsx`: N selector (15/30/60/all — "all" sends `expires_within_minutes=10080`, which still sorts soonest-first, rather than dropping the filter and losing the sort), soonest-first list, per-row "Expire now" with `window.confirm`, reusing the existing `POST /orders/:id/expire` via `useOrderAction`. Full loading/error/empty states, pagination like every other list.
- `orders-api.ts`: `OrderListFilter.expires_within_minutes` added; `useOrders` needed no change (object spread already forwards it as a query param).
- Route wired in `router.tsx`, nav item added in `app-layout.tsx` (ops-only, same gate as Inventory/Price lists/Organisations). Updated `test/role-gated-actions.spec.ts` for the new nav item.
- **Route-level gate**: a buyer/buyer_admin hitting `/reservations` by URL is redirected to `/orders` in `beforeLoad` (see item 3 below — same pattern used for every create-page gate).

## 2. Order detail: audit timeline + reservations + state machine

- **State machine**: wave 1 already rendered exactly the 5 v1 statuses correctly (`order-status.tsx`). I extracted `reachedStatuses()` and `RENDERED_STATUSES` as pure exports (previously inline in the component) and added the missing spec test #4: `apps/web/test/order-state-machine.spec.ts` (7 tests, all green) — asserts the 5 rendered statuses, the 3 no-producer statuses never render, and the reached-set for each status.
- **Reservations on the order**: there is no `GET /orders/:id/reservations` endpoint, and I deliberately didn't add one. Every order line holds exactly one reservation whose status always mirrors the order's own status — this is a database invariant the API's own tests already check (`stockInvariantViolations` in `apps/api/test/helpers/ordering-fixtures.ts`: `r.status <> CASE o.status WHEN 'reserved' THEN 'held' ... ELSE 'released' END`). So `apps/web/src/features/orders/order-reservations.tsx` derives the per-line hold status client-side from `OrderView` alone (`reservationStatusFor`), avoiding a new backend surface entirely. Shown to every role (SKU + qty + status, same exposure level as the existing Lines table).
- **Audit timeline**: `apps/web/src/features/audit/audit-api.ts` (`useAuditLog`) + `apps/web/src/features/orders/order-audit-timeline.tsx`, calling `GET /ops/audit?aggregate_type=order&aggregate_id=<id>`. Rendered in `order-detail-page.tsx` only behind `isOpsAdmin(session)` — never requested for other roles, so no spurious 403.

## 3. Nav + role gating, plus the waves 2-4 review fixes

- Reservations nav item, ops-only (item 1).
- **M4 (dropdown cap at 100)**: built `apps/web/src/components/ui/search-select.tsx`, a generic type-as-you-search combobox (styling/behaviour only, no fetch logic — matches the `components/ui/` convention) plus `apps/web/src/lib/use-debounced-value.ts`. Wired into:
  - Add-tier product picker (`price-list-detail-page.tsx`) — server-side search via `useProductList({ name })` (the API's `name` filter is `ILIKE`; `sku` is exact-match only, so name is the searchable field).
  - Inventory list's product/warehouse filters (`inventory-list-page.tsx`) — same pattern, `useProductList`/`useWarehouseList`.
  - New-user and new-price-list organisation selects — **client-side filtered**, not server-side: `GET /organizations` only supports an exact `code` match server-side (no partial-name filter), and `identity`/`organizations.ts` aren't in this phase's ownership, so I didn't add one. The 100-row cap on organisations itself therefore still exists; what changed is that finding an org among however many load is now type-to-search instead of scrolling a `<select>`. Flagging this as a residual gap: a partial-name filter on `GET /organizations` (identity module) would remove the cap properly and is a natural follow-up, out of scope here.
  - Left `new-order-page.tsx`'s product/warehouse pickers alone — not in the review's list of affected screens, and changing it wasn't asked for (YAGNI).
- **Low-3 (create pages reachable by URL for roles that 403)**: added `beforeLoad` redirects in `router.tsx` for `/catalog/products/new`, `/catalog/warehouses/new`, `/price-lists/new`, `/organizations/new` (→ `isOpsAdmin`) and `/users/new` (→ `canManageUsers`), each bouncing to its list page instead of flashing a form that will 403 on submit. Chose redirect over a "Not permitted" state component: it's the pattern the router already uses (login/authed guards), and it's fewer moving parts than adding and importing a new state component into five pages.
- Did **not** touch H1/H2/M1/M2/M3/M5 or the other Low items — not requested for this phase, and M5 (query cache not cleared on logout) turned out to already be fixed (`app.tsx` already calls `queryClient.clear()` on identity change) — the review predates that fix or it landed with another wave.

## 4. E2E — `apps/web/e2e/ops-order-lifecycle.spec.ts`

Added `@playwright/test` as a web devDependency, `apps/web/playwright.config.ts`, and `test:e2e` script. **Ran it successfully** against the live local stack:

- `docker compose up -d` was already running (postgres, redis, api, web, litellm all healthy) with seed data present.
- Order is placed directly through the API (buyer `admin@buyer-a.local`) rather than the UI, so the scenario stays focused on what was asked: ops logs in, opens the order, cancels, and the UI shows stock back. Product/warehouse: `PAPER-A4-70` / `HN-01` from the seed catalog (plenty of stock, 200 units at HN-01).
- Browser flow: login as `ops.admin@stockflow.local` → search the order by code → open it → click Cancel → accept the `confirm()` dialog → assert `cancelled` status, the reservation panel shows `released`, then navigate to the inventory detail page and assert `available_qty` is back to its pre-order value.
- **First run against the `docker compose` `web` service failed** — not a test bug: that container serves a pre-built image from before this session's frontend changes (11h-old build), so the Reservations panel and other new UI weren't there yet. Re-ran against `pnpm --filter @stockflow/web dev` (Vite dev server, current source) and it **passed**.
- Exact commands to reproduce (also in the spec's header comment):
  ```
  docker compose up -d postgres redis
  docker compose up migrate                 # applies migrations + seeds demo data
  pnpm --filter @stockflow/api start:dev    # or: docker compose up -d api
  pnpm --filter @stockflow/web dev          # NOT `docker compose up -d web` unless you rebuild that image first

  cd apps/web
  pnpm exec playwright install chromium     # one-time browser download, ~310MB
  E2E_BASE_URL=http://localhost:5173 E2E_API_URL=http://localhost:3100 pnpm test:e2e
  ```
- Skipped the copilot e2e scenario, as instructed (phase 08 deferred).
- Cleaned up: killed the dev server, removed `apps/web/test-results/`, and added `apps/web/test-results/` + `apps/web/playwright-report/` to the root `.gitignore` (not in the explicit ownership list, but a direct, low-risk consequence of adding e2e/Playwright to `apps/web/**`).

## 5. contracts-sync test

`apps/web/test/contracts-sync.spec.ts`, gated on `E2E_API_URL` (skips by default so `pnpm test` stays hermetic; ran green with the API up). **Mostly skipped by design, not by omission**: `packages/contracts` has exactly one response-shaped zod schema, `errorEnvelopeSchema` — every `*View` type (`OrderView`, `UserView`, `AuditLogView`, ...) is a plain TS interface with no runtime validator (confirmed by grepping every `z.object`/`z.array` in the package — all of them back request bodies or query strings, none back a success response). So the test parses a real 401 error envelope through `errorEnvelopeSchema` and stops there; extending it to "successes parse too" would mean inventing schemas the package doesn't have, which isn't this task.

## 6. `docs/adr/0025-spa-over-ssr.md`

Written in the existing ADR format (Status/Context/Decision/Consequences, matching 0018/0019). Core argument: no SEO surface behind a login, no benefit to a second identity/token-holding surface on a server render, and the SPA keeps the phase's refresh-mutex/token-in-memory model unmodified. Notes the v1.1 buyer-portal idea from the phase spec as the one scenario where SSR's argument would actually apply — a new app, not a retrofit.

## 7. docker-compose / CORS

Both already correct, no changes needed:
- `docker-compose.yml` already has a `web` service (nginx, built from `apps/web/Dockerfile`, port 8080).
- `apps/api/src/platform/configure-app.ts` already calls `app.enableCors({ origin: CORS_ORIGINS, credentials: true })`, and `.env.example`/compose default `CORS_ORIGINS` to `http://localhost:5173,http://localhost:8080` — both the Vite dev origin and the compose web origin. Verified by actually logging in and using the app against both origins during the e2e/scroll checks.

## 8. Empty/error/loading + no horizontal scroll at 375px

Every new/changed screen (Reservations list, order detail's new Reservations/Audit cards, Inventory list's SearchSelect filters, the SearchSelect-based pickers) follows the existing `LoadingRows`/`ErrorState`/`EmptyState` pattern from `components/page-state.tsx`. Checked at 375px with a headless Chromium pass (`document.documentElement.scrollWidth` vs `clientWidth`) across every list, detail, and create screen, logged in as both ops_admin and buyer — **no overflow anywhere**, including the two ops_admin-only cards newly added to order detail.

## Files changed

**Backend**
- `packages/contracts/src/ordering.ts` (filter schema)
- `apps/api/src/modules/ordering/domain/order.ts` (`OrderFilter` field)
- `apps/api/src/modules/ordering/http/order.controller.ts` (pass-through)
- `apps/api/src/modules/ordering/infrastructure/sql-order.repository.ts` (`list()` only)
- `apps/api/test/ordering/reservations-filter.spec.ts` (new, 5 tests)

**Frontend**
- New: `features/orders/reservations-list-page.tsx`, `features/orders/order-reservations.tsx`, `features/orders/order-audit-timeline.tsx`, `features/audit/audit-api.ts`, `components/ui/search-select.tsx`, `lib/use-debounced-value.ts`
- New tests: `test/order-state-machine.spec.ts`, `test/contracts-sync.spec.ts`
- New e2e: `e2e/ops-order-lifecycle.spec.ts`, `playwright.config.ts`
- Modified: `router.tsx`, `app-layout.tsx`, `orders-api.ts`, `order-status.tsx` (extracted pure fns), `order-detail-page.tsx`, `inventory-list-page.tsx`, `price-list-detail-page.tsx`, `new-price-list-page.tsx`, `new-user-page.tsx`, `test/role-gated-actions.spec.ts`, `package.json` (+`@playwright/test`, `test:e2e` script; `test` script now excludes `e2e/**`)

**Docs / infra**
- `docs/adr/0025-spa-over-ssr.md` (new)
- `.gitignore` (+ playwright artifact dirs)
- `pnpm-lock.yaml` (playwright dependency)

## Verification

- `pnpm typecheck` (all 4 workspace projects): pass
- `pnpm lint`: pass, 0 findings
- `pnpm --filter @stockflow/web test`: pass, 5 files, 29 tests + 1 hermetically-skipped
- `pnpm --filter @stockflow/web build`: pass (pre-existing single >500kB chunk warning, unrelated to this phase, not touched)
- New API tests (`reservations-filter.spec.ts`): pass, 5/5
- `pnpm --filter @stockflow/api test` (full): **422/422 individual tests pass**, but the process exits 1 because of an unrelated pre-existing issue: `test/platform/checked-out-client-error.spec.ts` emits an "Unhandled Rejection" warning (a deliberately-killed Postgres connection whose rejection is handled asynchronously, per Node's own `PromiseRejectionHandledWarning`) — isolated re-run of just that file reproduces the same warning with the same 1/1 tests passing. That file and `platform/database/` are the parallel agent's ownership; I did not touch either and did not attempt to fix it.
- `pnpm test` (root, API only): same result as above.
- E2E: ran and passed against the live stack (see §4).
- 375px scroll check: pass on every touched/new screen (see §8).

## Status: DONE

## Summary
Reservations screen (backend filter + frontend list with expire action), order-detail audit timeline and reservations panel, nav/role gating including redirect-gating on create pages, the M4 dropdown-cap fix via a new SearchSelect combobox, a working e2e test (verified green against the live stack, with the stale-docker-image gotcha documented), a honestly-scoped contracts-sync test, and ADR 0025. No new migration was needed for the reservations filter — verified via `EXPLAIN` that the existing partial index already covers it.

## Concerns
- Organisation pickers (New user, New price list) are still capped at whatever `GET /organizations?limit=100` returns — client-side search only, because the identity module (out of this phase's ownership) has no partial-name filter to search against server-side. Low risk today (a handful of buyer orgs in practice) but will resurface if the org count grows.
- `test/platform/checked-out-client-error.spec.ts`'s unhandled-rejection warning makes `pnpm test`/`pnpm --filter @stockflow/api test` exit non-zero even though every assertion passes. Pre-existing, outside this phase's ownership (platform/database) — flagging so it isn't mistaken for something this work broke.
- The docker-compose `web` image is stale relative to current source (built 11h before this session). Not something to fix here, but anyone running the e2e or manually clicking through `docker compose up -d web` will not see today's changes until it's rebuilt (`docker compose build web`).

---

## Review fixes

Response to `plans/reports/from-code-reviewer-to-main-260919-0154-phase-09-remainder-review-report.md`. Per the coordinator: `sql-order.repository.ts` is now fully mine (the parallel agent finished), and HEAD (`85fba15`) already fixed the `checked-out-client-error.spec.ts` flake, so `pnpm test` is expected — and confirmed — to exit 0.

### H1 — `/reservations` overflows at 375px
`components/ui/primitives.tsx`'s `Table` wrapper is now `relative w-full overflow-x-auto` (one line). The `sr-only` "Actions" header span in `reservations-list-page.tsx` was absolutely positioned against the viewport, not the wrapper, because the wrapper had no positioning context. Re-verified in a real browser at 375px with a genuinely non-empty reservations list (seeded a live reserved order via the API, not the empty state that hid this the first time): `scrollWidth === clientWidth === 375` on `/reservations`, plus a fresh pass over every other table screen.

### H2 — SearchSelect couldn't clear a selection
Added an `emptyOption` prop: when set, it renders as a permanent first row (id `''`) in the flattened item list a new pure export, `buildSearchSelectItems`, builds — so there is always a way back to "all"/"default" via click or Enter (which defaults to the top row), regardless of what the live search narrowed the real options down to. Wired into the two regressed pickers the review named: Inventory's product/warehouse filters ("All products"/"All warehouses") and New price list's organisation picker ("Default (all buyers)"). Left Add-tier and New-user's org select alone — a choice is required there, so there is nothing to clear back to.

New test: `test/search-select.spec.ts` (4 tests) covers the pure `buildSearchSelectItems` logic — the clear row is always first, survives a search that empties the real options, and a falsy-but-defined `emptyOption` (`''`) still counts as "provided." Same pure-function-extraction pattern as `reachedStatuses`/`ledgerRows` elsewhere in this codebase, chosen because there is no jsdom/RTL in this project (matching the reviewer's own no-new-dependency steer for M3(b)).

**Found and fixed a real bug while verifying this by hand in a browser** (not something the review flagged, but it blocked verifying H2 properly): after picking an option, the input keeps focus (its `onMouseDown`'s `preventDefault` is what stops the browser's default blur-before-click race), so clicking it again to reopen the dropdown was *not* a focus transition and `onFocus` never re-fired — the dropdown stayed permanently closed after one pick. Added `onClick={() => setOpen(true)}` alongside `onFocus`. Verified end-to-end in a real browser: pick → reopen → see the full list again (with the clear row) → click "All products" → URL param removed → no overflow, for both the inventory pickers and the price-list org picker.

Also picked up, cheaply, while touching this component (not separately requested but low-risk and directly adjacent): a `highlight` clamp when `options.length` shrinks, and a deferred blur-close so tabbing away actually closes the listbox.

### M1 — inventory filter label going blank past page 1 / on reload
`inventory-list-page.tsx` now falls back to `useProduct(search.product_id ?? '')` / `useWarehouse(search.warehouse_id ?? '')` when the selected id isn't in the current (paged, filtered) `productOptions`/`warehouseOptions`. Added `enabled: id !== ''` to both `catalog-api.ts` hooks so the fallback doesn't fire `GET /products/` with an empty id when nothing is selected — this is a real behavior change to those two shared hooks, but every existing call site already always passed a real id, so it's additive.

### M2 — partial index depends on custom planning; repository trusted the HTTP schema
`sql-order.repository.ts`'s `expiresWithinMinutes` branch now pushes a **literal** `o.status = 'reserved'` (not a bound parameter) alongside the existing bound `filter.status` check. Re-ran the reviewer's own `EXPLAIN` check locally (`plan_cache_mode=force_generic_plan`) — confirmed the bound-only version does fall back to a sequential scan under a generic plan, and the literal fixes it back to `Index Scan using idx_orders_reserved_expiry`.

Extended `reservations-filter.spec.ts` with a repository-level test (`app.get(OrderRepository).list(...)`, bypassing the HTTP schema entirely) that cancels an order (which keeps its `reservation_expires_at` — nothing nulls it on `updateStatus`) and calls `list({ expiresWithinMinutes })` **without any status filter**, asserting the cancelled order never comes back. **Verified this test actually catches the regression**: temporarily reverted the literal, reran — the new test failed exactly as expected (`expected [...] to not include '<cancelled-order-id>'`) — then restored the fix and confirmed green again.

### M3(a) — two-tab refresh e2e
Added `apps/web/e2e/two-tab-refresh.spec.ts`, opt-in via `E2E_ACCESS_TTL_SECONDS` (skips by default so the normal `pnpm test:e2e` run against a 900s-TTL API doesn't hang). Took the "force expiry via env" approach the review preferred over dropping the in-memory token via a page hook. Two tabs in one `BrowserContext`: tab 1 logs in, tab 2 hydrates its own session from the shared refresh cookie, then — after the short TTL genuinely expires server-side — both tabs click the same nav link at the same time (a real 401-retry, not `page.reload()`, which would trigger the unrelated initial-hydration path regardless of whether the token had actually expired). Asserts exactly one `/auth/refresh` request across both tabs' combined network activity, and that both land on `/inventory` successfully (no rotation-reuse logout).

**Ran it for real**: stopped the docker `api` container, started a local `pnpm --filter @stockflow/api start:dev` against the same Postgres/Redis with `JWT_ACCESS_TTL_SECONDS=3`, ran both e2e specs together (`ops-order-lifecycle` unaffected by the short TTL, `two-tab-refresh` passing: exactly 1 refresh call, both tabs on `/inventory`), then restored the docker `api` container to its normal state.

### M3(b) — test #4 should render the component
Renamed `test/order-state-machine.spec.ts` → `.spec.tsx`. Added a second `describe` block that renders `<OrderStateMachine status={...} />` via `renderToStaticMarkup` from `react-dom/server` (already a dependency — no jsdom/RTL added) and asserts against the real output: exactly the 5 v1 statuses render (and none of the 3 without a producer), exactly one node carries `aria-current="step"` with the current-status styling (`bg-primary`), a reached-but-not-current node gets `border-primary/60` (not current, not unreached), and an unreached node gets `border-dashed`/`opacity-60` (neither current nor reached) — for both the main path and the side exits. This now fails if the component's JSX changes (e.g. an extra node), which the old constant-only test could not catch.

### Lows fixed
- **Tautological e2e assertions**: `ops-order-lifecycle.spec.ts` now asserts `page.locator('[aria-current="step"]')` has the expected text, instead of a bare `getByText('reserved'|'cancelled')` — the old assertions passed regardless of which status was actually current, because the state machine's side-exit labels render that exact text too.
- **contracts-sync title/wording**: the test now performs a real authenticated `GET /orders/<random-uuid>` and gets a genuine 404 (`ORDER_NOT_FOUND`) instead of an unauthenticated 401 the title never claimed to test. Also corrected the header comment, which had put words in `packages/contracts/src/index.ts`'s mouth ("responses are not re-validated by design") that the file doesn't say.
- **Quoted the exclude glob**: `"test": "vitest run --exclude 'e2e/**'"` in `apps/web/package.json`, so a POSIX shell doesn't expand it to filenames before vitest sees it.
- **Typechecked `e2e/`**: `apps/web/tsconfig.json`'s `include` now covers `test`, `e2e` and `playwright.config.ts` (previously only `src` and `vite.config.ts` — the review correctly noted `test/` had the same gap already, not just `e2e/`). This surfaced one pre-existing latent error in `test/ledger-timeline.spec.ts` (`noUncheckedIndexedAccess` on an array-destructured possibly-undefined row) that had never been typechecked before; fixed it (`[0]!` instead of destructuring) since `pnpm typecheck` must stay green.
- **Buyer redirected from `/price-lists/new`**: now branches on `isOps(session)` — an `ops` (non-admin) user still bounces to `/price-lists` (they can read it), but a buyer/buyer_admin now bounces to `/orders` instead of trading one 403 for another.
- **Paid orders showing a stale "Hold ends"**: both `order-detail-page.tsx`'s Details card and `order-reservations.tsx`'s per-line table now show the deadline only when `order.status === 'reserved'` (a `paid` order is still technically "held," but the sweep never acts on it once paid, so the old deadline is stale and would misleadingly read as hours overdue) — `—` otherwise.
- **Softened the "database enforces" comment**: `order-reservations.tsx`'s header comment now attributes the reservation/order-status mirror to the application (`OrderTransitions.apply` settling every held reservation of an order in the same transaction, one status for all of them) and to the test suite that checks it, not to a database constraint that doesn't exist.
- **Docker images stale**: not changed (compose untouched, as instructed). To pick up every change in this round: `docker compose build api web && docker compose up -d api web`. The API image in particular needs it — the review's own probe showed it silently ignoring the (then-new) `expires_within_minutes` param and returning paid/cancelled orders that still carry a `reservation_expires_at`.

### Verification (this round)
- `pnpm typecheck`: pass (4 projects, now including `apps/web/test` and `apps/web/e2e`)
- `pnpm lint`: pass, 0 findings
- `pnpm --filter @stockflow/web test`: pass — 5 files (added `search-select.spec.ts`), 38 tests + 1 hermetically-skipped (up from 29; `order-state-machine.spec.tsx` grew from 7 to 12 tests with the render-based assertions)
- `pnpm --filter @stockflow/web build`: pass
- `pnpm --filter @stockflow/api exec vitest run test/ordering`: pass, 22 files, **71 tests** (up from 70 — the new M2 repository-level test)
- `pnpm test` (root/API, full): **pass, exit 0**, 85 files, **423 tests** (the coordinator's note about HEAD's flake fix was correct — confirmed, no `--forbid-only`/retry tricks needed)
- Both e2e specs, run together against the live stack (`ops-order-lifecycle` against the normal docker API; both specs together against a short-TTL local API instance for the `two-tab-refresh` scenario): **2/2 pass**
- 375px re-check in a real browser with non-empty data: `/reservations` (1 seeded row) now `375 = 375`; inventory pickers after pick/reopen/clear also `375 = 375`

### Status: DONE

### Summary
All 5 must-fix items (H1, H2, M1, M2, both halves of M3) and all 8 requested Low items are fixed and verified — most of them against a live browser/API, not just by code reading, including one bug (SearchSelect's reopen-after-pick) that verification surfaced and fixed along the way. Full `pnpm test` exits 0 as the coordinator expected. `sql-order.repository.ts`'s `list()` method is the only part of that file touched, matching the ownership handoff.

### Concerns
- None new. The organisation-picker cap and the docker-image staleness noted in the original report both still stand as documented there (the docker note is now more concrete: confirmed live that the stale API silently drops `expires_within_minutes`).
