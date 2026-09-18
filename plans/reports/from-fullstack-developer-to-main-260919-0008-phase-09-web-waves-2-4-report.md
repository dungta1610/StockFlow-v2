# Phase 09 web ops console — waves 2-4 (inventory, catalog + pricing, orgs + users)

Date: 2026-09-19

## Scope delivered

Wave 1 (foundation + Orders) was already done and committed. This pass adds:

- **Wave 2 — Inventory**: list + filter (product/warehouse), detail with a ledger
  timeline (before/after per row, colour-coded up/down), and an ops-only adjust-stock
  form (signed delta + reason).
- **Wave 3 — Catalog + pricing**: Products list/detail (+ create/edit for
  `ops_admin`), Warehouses list/detail (+ create/edit for `ops_admin`), Price lists
  list/detail with tiers, add/update-tier form, and archive.
- **Wave 4 — Orgs + users**: Organisations list/detail/create; Users list/detail
  (edit inline)/create.

Not touched, per scope: Reservations, audit timeline, Copilot, e2e.

## Screens and routes

| Route | Screen | Role gate (UI) |
|---|---|---|
| `/inventory` | Inventory list + filter | nav: ops only (API: `ops`/`ops_admin`) |
| `/inventory/$inventoryId` | Detail + ledger + adjust form | adjust form: ops only |
| `/catalog/products` | Products list + filter | write button: `ops_admin` |
| `/catalog/products/new`, `/catalog/products/$productId` | Create / detail+edit | edit: `ops_admin` |
| `/catalog/warehouses`, `/new`, `/$warehouseId` | same pattern | edit: `ops_admin` |
| `/price-lists` | List + filter | nav: ops only; create: `ops_admin` |
| `/price-lists/new`, `/price-lists/$priceListId` | Create / detail (tiers, add-tier, archive) | write: `ops_admin` |
| `/organizations`, `/new`, `/$orgId` | List/detail/create | nav: ops only; create: `ops_admin` |
| `/users`, `/new`, `/$userId` | List/detail(edit)/create | nav + all actions: `ops_admin` or `buyer_admin` (matches the `/users` controller's class-level `@Roles`) |

Nav entries in `app-layout.tsx` are now computed by `navItemsFor(session)` (exported,
tested) instead of a static list, gated with the same `isOps`/`canManageUsers` helpers
used inside the screens — a plain buyer sees Orders/Products/Warehouses only; ops sees
+Inventory/Price lists/Organisations; `ops_admin`/`buyer_admin` additionally see Users.

## Files

**New**
- `apps/web/src/features/inventory/{inventory-api.ts,ledger-timeline.tsx,inventory-list-page.tsx,inventory-detail-page.tsx}`
- `apps/web/src/features/catalog/{catalog-api.ts,products-list-page.tsx,product-detail-page.tsx,new-product-page.tsx,warehouses-list-page.tsx,warehouse-detail-page.tsx,new-warehouse-page.tsx}`
- `apps/web/src/features/pricing/{pricing-api.ts,price-lists-list-page.tsx,price-list-detail-page.tsx,new-price-list-page.tsx}`
- `apps/web/src/features/orgs/{orgs-api.ts,organizations-list-page.tsx,organization-detail-page.tsx,new-organization-page.tsx}`
- `apps/web/src/features/users/{users-api.ts,users-list-page.tsx,user-detail-page.tsx,new-user-page.tsx}`
- `apps/web/test/ledger-timeline.spec.ts`, `apps/web/test/role-gated-actions.spec.ts`

**Modified**
- `apps/web/src/router.tsx` — 18 new routes (code-based, matching wave 1's style).
- `apps/web/src/app-layout.tsx` — dynamic, role-gated nav (`navItemsFor`, exported).
- `apps/web/src/features/auth/session.ts` — added `canManageUsers`.
- `apps/web/src/features/orders/orders-api.ts` — `useWarehouses`/`useProducts`/
  `useOrganizations`/`useQuote` moved to their own domain modules (catalog/orgs/pricing)
  and re-exported under their old names, so `new-order-page.tsx` and
  `orders-list-page.tsx` needed zero changes. Pure move, no behaviour change (same
  query keys, same staleTime).
- `packages/contracts/src/identity.ts` — added `export type OrgTypeValue` and
  `export type RoleValue` (both already existed as anonymous `z.infer<...>` inline
  types; just named them, mirroring the existing `OrderStatusValue` pattern).
- `packages/contracts/src/pricing.ts` — added `export type PriceListStatusValue`,
  same reasoning; `PriceListView.status` now uses it instead of an inline
  `z.infer<...>`.
- Did **not** touch `packages/contracts/src/index.ts` (both types are already
  re-exported via the existing `export * from './identity'` / `'./pricing'`). The
  file shows as modified in git status only because the parallel Phase 05 agent
  appended `audit.ts`/`outbox.ts` exports there — confirmed via `git diff`, not my
  change.

Every request/response type used comes from `@stockflow/contracts` (`InventoryView`,
`InventoryTransactionView`, `ProductView`, `WarehouseView`, `PriceListView`,
`PriceListItemView`, `OrganizationView`, `UserView`, `MembershipView`, and their
request schemas). Nothing was redeclared.

## Tests

- `test/ledger-timeline.spec.ts` (7 tests) — the pure `ledgerRows()` helper extracted
  from the ledger component: before/after pairs preserved, up/down/flat direction
  correctly derived for both available and reserved sides (including a reserve moving
  stock from available to reserved in one row), order preserved, empty input handled.
- `test/role-gated-actions.spec.ts` (9 tests) — `isOps`/`isOpsAdmin`/`canManageUsers`
  against buyer/buyer_admin/ops/ops_admin sessions; `navItemsFor` per role (verifies
  Users is hidden for plain `ops`, Inventory/Price lists/Organisations hidden for
  buyers); `rolesForOrgType` mirrors the API's `ROLES_BY_ORG_TYPE`.

No new test dependencies were added (no `@testing-library`/jsdom): both new spec
files test pure functions, consistent with the existing `api-client.spec.ts`
convention and the "avoid adding npm dependencies" constraint. Importing
`app-layout.tsx` in the Node test environment is safe — all DOM/`localStorage`/
`matchMedia` access in `theme-toggle.tsx` happens inside component functions, not at
module scope.

`pnpm --filter @stockflow/web test`: 3 files, 22 tests, all passing (6 pre-existing +
16 new).

## Verification

- `pnpm --filter @stockflow/contracts typecheck` — pass.
- `pnpm --filter @stockflow/web typecheck` — pass.
- `pnpm --filter @stockflow/web test` — pass (22/22).
- `pnpm --filter @stockflow/web build` — pass (only the pre-existing >500kB single-chunk
  warning, unrelated to this change).
- `pnpm lint` — pass, 0 errors.
- Did not commit, per instructions.
- `apps/api` typecheck currently fails on an unrelated pre-existing issue
  (`SqlOrderRepository` missing `listReservedExpiredIds`) in files that `git status`
  shows as uncommitted changes from the parallel backend Phase 05 agent — not caused
  by anything in this change (I never touched `apps/api` or `apps/ordering`).

## Design notes / responsive & role-aware UI

- Every screen follows the wave-1 loading/error/empty triad
  (`LoadingRows`/`ErrorState`/`EmptyState`) and reuses the existing primitives
  (`Table`/`Card`/`Badge`/`Button`/`Select`/`Input`), so dark/light and the
  "table scrolls in its own box, never the page" contract carry over unchanged.
- Filter forms use `sm:grid-cols-[...]` (single column below `sm`), matching the
  orders list page, so nothing overflows at 375px; the header nav now wraps
  (`flex-wrap`) since it can have up to 7 items for `ops_admin`.
- Write actions are hidden, not just disabled, when the actor's role cannot perform
  them (`isOpsAdmin`/`canManageUsers` checks before rendering buttons/forms) — the API
  is still the authority; a direct URL hit yields the existing `ErrorState` rendering
  the API's `ApiError` (code + message), same pattern as the rest of the app.

## Backend gaps / awkward spots found (no `apps/api` changes made)

1. **No organisation update endpoint.** `OrganizationController` only has
   `POST`/`GET`/`GET :id` — no `PUT`. The org detail screen is read-only
   (deliberately: no edit form was built, rather than building one against a
   nonexistent endpoint). If ops need to deactivate/rename an org later, that's a
   backend gap, not a frontend one.
2. **Price list "Scope" org lookup is a second query.** `PriceListView.org_id` is a
   bare id; the detail page cross-references `useOrganizations()` client-side to show
   the org's code/name. A presenter-level `org_code` on `PriceListView` (like orders
   already do for buyer orgs elsewhere) would avoid this extra round trip, but it's a
   minor, optional nicety, not a blocker.
3. **Quote preview for ops-on-behalf-of-a-customer** was left out of the price-list
   screens — `useQuote()` already supports an optional `customer_org_id` (added
   defensively) but no screen currently surfaces it, since the existing New Order
   quote panel already covers the primary use case and the phase note said "if
   useful." Flagging in case a later phase wants an ops-side "preview this list's
   effect on a quote" panel.

## Unresolved questions

- None blocking. The org-update gap and quote-preview omission above are scope
  decisions I made to stay within wave 2-4's stated boundaries (YAGNI); revisit if a
  later phase specifically needs them.

Status: DONE
Summary: Inventory, Catalog (products/warehouses), Price lists, Organisations and Users screens shipped with role-gated nav/actions, 16 new focused tests, zero new contract-type redeclarations (only 3 additive named-type exports in packages/contracts), typecheck/test/build/lint all green, nothing committed.
Concerns/Blockers: None. Noted three backend gaps/nice-to-haves above (no org update endpoint; price-list org lookup could use a presenter-level org_code; ops-side quote preview left out as optional) — informational only, not blocking.
