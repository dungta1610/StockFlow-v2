# Code review: Phase 09 remainder (Reservations, audit timeline, pickers, e2e)

Date: 2026-09-19 · Reviewer: code-reviewer · Scope: every modified/untracked file in `git status` except `.claude/`

## Scope
- Backend: `packages/contracts/src/ordering.ts`, `apps/api/src/modules/ordering/{domain/order.ts,http/order.controller.ts,infrastructure/sql-order.repository.ts}`, `apps/api/test/ordering/reservations-filter.spec.ts`
- Web: `router.tsx`, `app-layout.tsx`, `features/orders/{reservations-list-page,order-reservations,order-audit-timeline,order-detail-page,order-status,orders-api}.tsx/ts`, `features/audit/audit-api.ts`, `components/ui/search-select.tsx`, `lib/use-debounced-value.ts`, `features/{inventory/inventory-list-page,pricing/new-price-list-page,pricing/price-list-detail-page,users/new-user-page}.tsx`
- Tests/config: `test/{order-state-machine,contracts-sync,role-gated-actions}.spec.ts`, `e2e/ops-order-lifecycle.spec.ts`, `playwright.config.ts`, `package.json`, `pnpm-lock.yaml`, `.gitignore`, `docs/adr/0025-spa-over-ssr.md`
- About 260 changed lines in tracked files, plus about 900 lines in new files.

## Gates (all run by me)
| Command | Result |
|---|---|
| `pnpm typecheck` | pass (4 projects) |
| `pnpm lint` | pass, 0 findings |
| `pnpm --filter @stockflow/web test` | pass: 4 files, 29 tests; contracts-sync is 1 skipped |
| `pnpm --filter @stockflow/web build` | pass. The >500 kB chunk warning already existed |
| `pnpm --filter @stockflow/api exec vitest run test/ordering` | pass: 22 files, 70 tests |
| `pnpm test` (full) | **exit 0**: 85 files, 422 tests. The implementer's report says it exits 1, but that is stale: HEAD `85fba15` already fixed the unhandled rejection |

## Empirical checks I ran
- **375px browser probe.** I ran Playwright against the Vite dev server on :5173, which serves the current source, with the docker API.
  - `/reservations` has a page scrollWidth of 556 against a clientWidth of 375, so the page **overflows horizontally** (H1).
  - Order detail, inventory and the create pages all come out at 375 = 375.
- **Audit gating.** The same probe logged `/ops/audit` requests:
  - ops_admin opening order detail: 1 request.
  - buyer_admin opening the same order: 0 requests.
- **Buyer route guards.** buyer_admin on `/reservations` lands on `/orders`, on `/catalog/products/new` lands on `/catalog/products`, and on `/price-lists/new` lands on `/price-lists` (see Low 7). `/users/new` is allowed, which matches the API.
- **EXPLAIN on Postgres 16.** I inserted 200k orders inside a transaction and rolled it back afterwards.
  - Custom plan: `Index Scan using idx_orders_reserved_expiry`, then an Incremental Sort.
  - Generic plan (`plan_cache_mode=force_generic_plan`, `status = $1`): `Parallel Seq Scan` + Sort. The partial index cannot be used (M2).
- **Stale docker API.** The running `stockflow-v2-api-1` container predates this change. `GET /orders?expires_within_minutes=15&status=paid` returns 200 instead of 400: the stale API silently strips the unknown param. That same response returns cancelled and fulfilled orders that still have a non-null `reservation_expires_at`, which matters for M2.

## Overall assessment
The backend filter is well designed:
- Contract-level `refine` + `transform`, bind params only, OrgScope kept.
- Ordering unchanged when the filter is absent.
- Tests are good, including OrgScope and the 400.

The reservation-mirror claim holds by construction (see (c)). Two defects block the commit:
- **H1:** a 375px overflow that the implementer reported as checked.
- **H2:** a SearchSelect regression. It removed the "none / all / default" choice from the wave 2-4 pickers.

---

## Critical
None.

## High

### H1. The Reservations page scrolls horizontally at 375px (acceptance failure)
- **Where:** `apps/web/src/features/orders/reservations-list-page.tsx:81`, `<span className="sr-only">Actions</span>`, rendered inside `Table` (`components/ui/primitives.tsx:94`, `<div className="w-full overflow-x-auto">`).
- **Why:** `sr-only` is `position:absolute`. The table's scroll wrapper is not positioned, so the span's containing block is the viewport. The span therefore escapes the wrapper's overflow clipping and sits at its static position, about 556px from the left.
- **Proof:** In a real browser at 375px with one reserved order, `document.documentElement.scrollWidth` is 558. Removing that one span brings it to 375.
- **Why the implementer's check missed it:** it most likely ran on an empty list, where the empty state renders and there is no table.
- **Fix:** In one place, change `primitives.tsx:94` to `className="relative w-full overflow-x-auto"`. That also protects every future table that uses `sr-only`. Alternatively, drop the span and use `<Th aria-label="Actions" />`.

### H2. SearchSelect cannot clear a selection, which regresses the wave 2-4 pickers
- **Where:** `apps/web/src/components/ui/search-select.tsx:59-63`. `onChange` is only ever called with an option's id, so nothing can emit `''`.
- **Scenarios:**
  - **Inventory list filters** (`inventory-list-page.tsx:54-75`). Before this change, the `<select>` had "All products" and "All warehouses" options. Now, once a product is picked there is no in-page way back to "all". The user has to edit the URL or click the nav link.
  - **New price list** (`new-price-list-page.tsx:55-66`). Before, the list had "Default (all buyers)". Now, if an ops_admin picks an organisation by mistake, they cannot go back to a default list without reloading the page. Getting this wrong changes who the contract prices apply to.
  - **New user** org and **add tier** product: less serious, since a choice is required there anyway.
- **Fix:** Add a clear affordance:
  - an `allowClear`/`emptyLabel` prop that renders a first "All products" / "Default (all buyers)" option calling `onChange('')`, and/or
  - a clear (x) button when `value` is set, and/or
  - treating an input emptied and then blurred as `onChange('')`.

## Medium

### M1. The inventory filter label is looked up in the current search results, so the field goes blank while the filter is still active
- **Where:** `inventory-list-page.tsx:59` and `:70`: `selectedLabel={productOptions.find((o) => o.id === search.product_id)?.label}`.
- **How it goes blank:** `productOptions` is page 1 of `useProductList`, and `useProductList` uses `limit: 20` (`catalog-api.ts:58`).
  - After a pick, `pick()` resets the query to `''`. The options become the first 20 unfiltered products.
  - If the picked product is not among them, the input renders empty. The placeholder is also `undefined`, because `value && !open ? selectedLabel : …`.
  - Reloading `/inventory?product_id=<X>` has the same result.
- **Why it isn't visible today:** the seed has exactly 20 products, so this starts at product #21. That is the scenario M4 was meant to fix.
- **Correct pattern already in the diff:** `price-list-detail-page.tsx:136,168` stores the label in state at pick time.
- **Fix:** Do the same in inventory. For the URL-reload case, resolve the label with `useProduct(search.product_id)` / `useWarehouse(...)` when it is not in the options.

### M2. Using the partial index depends on custom planning, and the repository relies on the HTTP schema for correctness
- **Where:** `sql-order.repository.ts:207-225`.
- **Is the index used?** The claim holds today, but by luck of the driver.
  - node-pg sends unnamed statements, and Postgres custom-plans an unnamed statement with the real `$1='reserved'`. My EXPLAIN confirms `Index Scan using idx_orders_reserved_expiry`.
  - Under a generic plan the planner cannot prove `status = $1` implies `status = 'reserved'`. My EXPLAIN on 200k rows shows `Parallel Seq Scan on orders` + full Sort.
  - Plans become generic with `plan_cache_mode=force_generic_plan`, with named prepared statements reused 5+ times, or behind a pooler that prepares statements.
- **Correctness:** the repository comment says the status pairing is "enforced by listOrdersQuerySchema". Any future caller of `OrderRepository.list({ expiresWithinMinutes })` without `status` would return cancelled, fulfilled and expired orders. Those rows keep `reservation_expires_at`; I saw it in live data.
- **Fix:** In the `expiresWithinMinutes` branch, push the literal `o.status = 'reserved'`. You may still bind `filter.status`, since the schema guarantees they agree. This makes the index choice plan-independent and moves the invariant to the layer that owns the SQL. Add one repository-level test that calls `list()` without `status`.

### M3. Spec acceptance items this remainder does not cover (not Copilot/SSE)
- **Two-tab refresh e2e:** `phase-09-web-ops-console.md:157` asks for an e2e with two tabs expiring together, so that refresh is called once across the origin. There is no such scenario. `api-client.spec.ts` covers the lock only in unit form.
- **Test #4 is a constant check, not a render test:** the spec's test #4 is a render test (`order-state-machine.spec.tsx`). The delivered `test/order-state-machine.spec.ts` asserts the `RENDERED_STATUSES` constant and `reachedStatuses()`. It never mounts `OrderStateMachine`. The component iterates `MAIN_PATH`/`SIDE_EXITS` directly, so today a change to the component's JSX (e.g. drawing an extra node) would not be caught.
- **Action:** Accept both explicitly as residual scope, or add them: a DOM environment plus one render assertion, and a 2-context Playwright scenario.

## Low
1. **Order reservations panel** (`order-reservations.tsx`):
   - **Paid orders show a stale deadline:** for a `paid` order the "Hold ends" column shows a deadline that no longer applies (`:48`). The sweep only expires `status='reserved'`, so a paid order shows e.g. "(3 hours ago)". Show "—" or "no expiry" for `paid`.
   - **Header wording:** "Qty held" (`:34`) is wrong for released or consumed rows.
   - **Comment overclaims:** the comment at `:9` says "the database enforces this". It is enforced by the application (`OrderTransitions.apply`) and checked by tests, not by any constraint or trigger. Reword it.
2. **"All holds" is capped at 7 days:** it sends 10080 minutes (`reservations-list-page.tsx:11`), but `ORDER_RESERVATION_TTL_MINUTES` is an unbounded positive int (`env.schema.ts:36`). A TTL over 7 days silently hides holds under "All". Either cap the env var at 10080 or label the option "Next 7 days".
3. **The Reservations list goes stale:** "Time left" never updates; add `refetchInterval` (e.g. 30s) on this screen. A failed expire (e.g. 409 because the order was paid meanwhile) doesn't invalidate the list either, so the stale row stays.
4. **Two e2e assertions prove nothing:** `ops-order-lifecycle.spec.ts:100,105`. The state machine always renders nodes with the exact text `reserved` and `cancelled`, so both `getByText(..., {exact:true}).first()` checks pass before any action. The `released` cell and the inventory checks carry the test. Assert on `[aria-current="step"]` or on the status badge instead.
5. **contracts-sync spec wording:**
   - The test title says "a real 404" but the test asserts 401 (`contracts-sync.spec.ts:21,24`).
   - The header cites `packages/contracts/src/index.ts` for a "responses are not re-validated by design" rationale. The file doesn't say that; it says "single source of truth for request/response shapes". Fix the wording.
6. **Web tooling:**
   - `"test": "vitest run --exclude e2e/**"` is unquoted. Under POSIX `sh` (Linux CI) the glob expands to the actual file names, so a second e2e file becomes a positional vitest filter and gets run under vitest. Quote it or move `exclude` into a vitest config.
   - `apps/web/tsconfig.json` includes only `src` + `vite.config.ts`, so `e2e/**` and `playwright.config.ts` are never typechecked. `test/` has the same gap already.
7. **A buyer's pasted `/price-lists/new` URL lands on another page they can't read:** it redirects to `/price-lists` (`router.tsx:168`), which is ops-only read, so the buyer gets a 403 ErrorState. Redirect non-ops to `/orders`.
8. **SearchSelect polish:**
   - Tabbing away leaves the listbox open (there is no blur/`focusout` close).
   - `highlight` isn't clamped when `options` changes.
   - It lacks `aria-controls`/`aria-activedescendant`.
   - `loading` hides the options during background refetches.
   - Product search is `name` ILIKE only, while labels lead with the SKU: typing a SKU gives "No matches". Say so in the placeholder, or add a SKU prefix filter later.
9. **The audit timeline goes stale after an action:** the `['audit', …]` query isn't invalidated after an action on the detail page. The projection is async, so invalidating right away isn't enough on its own; a short `refetchInterval` while the card is mounted, or a refetch on window focus, would do.
10. **Implementer report corrections:**
    - "`pnpm test` exits 1" is false now: it exits 0.
    - "No overflow anywhere at 375px" is false: see H1.
    - The e2e header says `docker compose up -d web` works. It only works after `docker compose build web api`: the running API image also predates this change and silently ignores `expires_within_minutes`.

## Explicit checks requested

**(a) Acceptance**
| Item | Result |
|---|---|
| Reservations screen is ops-only | Pass. The nav item comes from `isOps`, and `beforeLoad` redirects buyers (verified in the browser) |
| Sorted soonest-first | Pass. `ORDER BY reservation_expires_at ASC, id ASC`, and the test covers the overdue row coming first |
| Confirm step before expire | Pass. `window.confirm` (`reservations-list-page.tsx`), the same pattern as cancel |
| Empty/error/loading states | Pass for the list and both new order-detail cards |
| Audit timeline only for ops_admin | Pass. `isOpsAdmin` gate; verified 0 `/ops/audit` requests as buyer_admin and 1 as ops_admin |
| State machine renders exactly 5 states | Pass by code reading. The test only covers the constant (M3) |
| No horizontal scroll at 375px | **Fail on /reservations (H1).** Pass elsewhere |

**(b) Backend filter**
- **Does it require status=reserved?** Yes, correctly. It implies `status=reserved` when status is absent and gives a 400 for any other status. Tested.
- **SQL safety:** bind params only. `make_interval(mins => $n)` takes an integer that zod has validated to 1..10080. NaN, decimals and arrays all get a 400.
- **OrgScope:** applied via `select()`, and the test covers buyer A, buyer B and ops.
- **Partial index:** used under custom plans (node-pg's current behaviour), not under generic plans (M2; EXPLAIN evidence above).
- **Regressions:** none. `ORDER BY created_at DESC, id DESC` is unchanged when the filter is absent, and the full suite is green.

**(c) "Reservation status always mirrors order status"**
- **Result:** verified true by construction.
  - `OrderTransitions.apply` locks the order, then `lockHeld` takes every held reservation.
  - `settle` then moves all of them to one status: `released` for cancelled/expired, `consumed` for fulfilled, and nothing changes for paid.
  - That happens in one transaction, with no LIMIT and no per-line path.
  - Partial consumption doesn't exist in v1. `stockInvariantViolations` asserts the mapping across the ordering suite.
- **Mapping:** the client mapping `reservationStatusFor` matches the test's CASE exactly.
- **Where it could diverge:** only through out-of-band SQL.
- **Real UI issue:** not a mismatched status but the paid-order deadline display (Low 1).

**(d) Waves 1-4 regressions**
- **orders-api / order-status / order-detail:** additive only. `useOrders` forwards the new field, and `reachedStatuses` is a pure extraction with the same logic.
- **Pickers:** they regress (H2, M1).
- **API types:** none redeclared. `OrderListFilter`/`AuditLogFilter` are local query-param interfaces, the pattern the previous review accepted in its Low 8. The contracts have no reservation-status type, so `DerivedReservationStatus` is fine.
- **Money:** no new money handling; the add-tier unit price is still a string.

**(e) E2E and config**
- **Secrets:** only `ChangeMe-123!`, which equals `SEED_PASSWORD` in `.env.example`, and it can be overridden via `E2E_SEED_PASSWORD`.
- **Artifacts:** `test-results/` and `playwright-report/` are gitignored (verified with `git check-ignore`). The reporter is `list` and the trace is `retain-on-failure`.
- **contracts-sync:** `describe.skipIf(!E2E_API_URL)` skips it hermetically (confirmed as "1 skipped").
- **Lockfile:** the diff adds only `@playwright/test`, `playwright` and `playwright-core` 1.63.0.
- **package.json:** only the devDependency and the scripts changed.

**(f) Gates:** all green; see the table above. `pnpm test` exits 0.

## Positive observations (for calibrating risk)
- Rejecting `status=paid` + window with a 400, rather than silently ignoring the window, is the right contract choice.
- Deriving the reservation panel from `OrderView` instead of adding an endpoint is justified by the code (see (c)).

## Recommended actions (in order)
1. H1: make the `Table` wrapper `relative` (one line).
2. H2: add a clear/"All"/"Default" option to SearchSelect.
3. M1: keep the selected label in state in inventory, or look it up.
4. M2: use the literal `o.status = 'reserved'` in the expiry branch.
5. M3: add the render test and the two-tab e2e, or record them as accepted residual scope.
6. Low items as time allows. Low 1 (paid deadline) and Low 4 (vacuous e2e assertions) are the most worthwhile.

## Unresolved questions
- The dev docker API has a `reserved` order that is 18+ hours overdue (`ORD-20260918-000001`). That is consistent with the image predating the expiry job. I didn't investigate further; rebuild the images before any manual QA.
- Is the two-tab e2e (spec line 157) in scope for this phase, or deferred along with the copilot e2e?

---
Status: DONE_WITH_CONCERNS
Summary: The backend filter, the audit gating, the reservation-mirror logic and all the gates are sound (`pnpm test` exits 0 with 422 tests). But `/reservations` overflows at 375px (H1, proven in a browser), and SearchSelect removed the ability to clear or pick "All"/"Default" on the inventory and new-price-list pickers (H2).
Concerns: H1 and H2 block the commit. M1 is the same component and should be fixed with H2. M2 is a small hardening. M3 needs a scope decision.
**OK to commit: NO** — it becomes yes once H1 and H2 are fixed (M1 strongly recommended in the same change).
