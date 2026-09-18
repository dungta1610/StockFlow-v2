# Code review: Phase 09 web waves 2-4 (Inventory, Catalog, Price lists, Orgs, Users)

Date: 2026-09-19
Scope: uncommitted `apps/web/**` changes plus `packages/contracts/src/{identity,pricing}.ts`. About 2,450 LOC are new under `features/{catalog,inventory,orgs,pricing,users}`, with about 180 LOC modified across `router.tsx`, `app-layout.tsx`, `session.ts` and `orders-api.ts`.
Checked against: the backend controllers, use cases and repositories for inventory, catalog, pricing and identity; `packages/contracts`; the phase-09 spec; and the implementer report.

## Gates (run by reviewer)

| Check | Result |
|---|---|
| `pnpm --filter @stockflow/web typecheck` | pass |
| `pnpm --filter @stockflow/web test` | pass, 3 files / 22 tests |
| `pnpm --filter @stockflow/web build` | pass. One warning: the bundle is a single 538 kB chunk (this was already the case) |
| `pnpm exec eslint apps/web packages/contracts` | pass, 0 findings |

## Overall assessment

The work is solid and closely follows the wave-1 patterns.
- Every API type comes from `@stockflow/contracts`.
- Money is only ever a string (formatted with `formatMoney`, never passed to `Number`/`parseFloat`).
- Query params and body fields match the backend Zod schemas one for one.
- Mutations invalidate using key prefixes.
- Each screen shows loading, error and empty states.
- The wave-1 re-export refactor keeps the old hook names and the exact query keys for warehouses and products.

Two defects will bite in production, both on the Users edit/create forms (H1, H2). The rest are medium or low.

## Critical

None.

## High

### H1. The user edit form always sends `is_active`, so a buyer_admin cannot change the role of any shared account
- **Where:** `apps/web/src/features/users/user-detail-page.tsx:92-102`. The line `is_active: isActive` is always sent.
- **Backend truth:** `apps/api/src/modules/identity/application/use-cases/user.use-cases.ts:113-117`:
  - `changesAccount = password !== undefined || isActive !== undefined || fullName changed`.
  - If `changesAccount && hasMembershipsOutsideScope`, the API returns 403.
- **Scenario:** A user belongs to two buyer organisations, A and B. The buyer_admin of A opens the user and changes only the role, buyer to buyer_admin. The UI sends `is_active: true` (unchanged), which the API counts as an account change, so every save returns 403 "account also belongs to another organisation".
  - The UI cannot predict this. `findById` filters memberships to the admin's scope and does not expose `hasMembershipsOutsideScope`.
  - The result is an action the role is allowed to perform (a role-only change) that always fails.
- **Fix:** Send account fields only when they actually changed:
  ```ts
  is_active: isActive !== user.is_active ? isActive : undefined,
  ```
  `full_name` is required by the schema and already compared by value on the server, so it is fine. Optionally, when a 403 of this kind comes back, show a hint that account fields are locked for shared accounts.

### H2. Admin password fields have no `autoComplete`, so the browser can fill in the admin's own password
- **Where:**
  - `apps/web/src/features/users/user-detail-page.tsx:140` (edit form, "New password")
  - `apps/web/src/features/users/new-user-page.tsx:58,62` (email and password)
- **Scenario (depends on the browser):**
  - Firefox, and Chrome in some layouts, autofill saved credentials into `type="password"` fields, using the text input just before it as the username.
  - On the edit form, the autofilled value is sent as `password`. The API then sets the target user's password to the admin's own password and `revokeAllForUser` logs them out everywhere (`user.use-cases.ts:120-132`). This happens silently, during what the admin thinks is a role change.
  - On New user, the admin's email and password can be pre-filled.
  - Wave 1's `login-page.tsx:74,89` sets `autoComplete` correctly. These new forms don't.
- **Fix:**
  - Password inputs: `autoComplete="new-password"`.
  - New-user email input: `autoComplete="off"`.
  - Better: on edit, keep the password field hidden behind an explicit "Set new password" toggle.

## Medium

### M1. The users list email filter says "contains", but the API matches exactly
- **Where:** `apps/web/src/features/users/users-list-page.tsx:64`, placeholder "Email contains…".
- **Backend:** `apps/api/src/modules/identity/infrastructure/sql-user.repository.ts` builds `u.email = $n` (exact match). Only `full_name` is `ILIKE %…%`.
- **Scenario:** Typing "acme" returns "No users match" even though acme users exist.
- **Fix:** Either relabel it "Exact email", or add a `full_name` partial filter, which the API already supports and `UserListFilter.full_name` already declares.

### M2. Passwords are trimmed on edit but not on create or login
- **Where:** `user-detail-page.tsx:96` uses `password.trim()`. `new-user-page.tsx:46` sends the raw value. The login schema (`identity.ts` `password = z.string().min(1)`) does not trim.
- **Scenario:** An admin resets a password to `"  Secret#1  "`. The stored password is `"Secret#1"`, but the user types the value they were given (with the spaces) and login fails.
- **Fix:** Send the value untouched: `password: password === '' ? undefined : password`.

### M3. The inventory ledger silently stops at 100 rows
- **Where:**
  - `apps/web/src/features/inventory/inventory-api.ts:47` requests `limit: 100` with no paging.
  - `inventory-detail-page.tsx:70` says "Every reserve, release, consume and manual adjustment, in order."
- **Backend:** `sql-ledger.repository.ts:90` sorts `ORDER BY created_at DESC`. After 100 movements the oldest rows vanish, and the screen doesn't say so.
- **Why it matters:** The ledger timeline is the acceptance criterion for this screen. A busy SKU passes 100 movements quickly.
- **Fix:** Add page controls (same pattern as the lists) or a "Load older" button that increments `page`. Change the copy to "newest first".

### M4. Reference dropdowns stop at the first 100 records
- **Where:**
  - `catalog-api.ts:50` (`useActiveProducts`, `limit: 100`) and `:96` (`useActiveWarehouses`)
  - `orgs-api.ts:24` (`useOrganizations`)
- **Newly affected screens:**
  - Add-tier form: `price-list-detail-page.tsx:129`. Product #101 and later cannot be priced at all.
  - Inventory list product and warehouse filters: `inventory-list-page.tsx:44-66`.
  - New-user and new-price-list org selects.
  - Org labels in the price-list and users lists, which fall back to an 8-character id prefix.
- **Background:** The API caps `limit` at 100 (`common.ts` `pagingQuerySchema`). The hooks came from wave 1, but waves 2-4 made them load-bearing for write paths.
- **Fix:** Use a type-to-search input backed by the list endpoint's `sku`/`name`/`code` filters, or page until a short page comes back. At minimum, show a note when 100 rows come back.

### M5. The query cache is never cleared on logout or when the user changes (existing, now worse)
- **Where:** `apps/web/src/lib/api-client.ts:64-67` (`logout` only calls `setSession(null)`) and `app.tsx:6` (the QueryClient lives for the whole app).
- **Scenario:** ops_admin logs out, and a buyer logs in on the same tab within the 5-minute `gcTime`. When the buyer opens a page whose cache key matches, the previous user's cached data renders until the refetch replaces it or fails with 403. Examples:
  - `['users','list',{page:1}]`: emails
  - `['products','list',…]`: inactive products
  - `['orders',…]`: other buyers' orders
- **Why raise it now:** This was already true in wave 1, but waves 2-4 add PII (user emails) and ops-only data (inventory, contract price lists) to the cache.
- **Fix:** Call `queryClient.clear()` when the session's `user.id` or `acting_as.org_id` changes, or on `setSession(null)`. For example, subscribe once in `app.tsx`.

## Low

1. **Implementer report says "same query keys"; not quite.**
   - `useOrganizations` moved from `['organizations']` to `['organizations','all']` (`orgs-api.ts:23`).
   - `useQuote` now adds `customerOrgId` to its key (`pricing-api.ts:76`).
   - Harmless: nothing reads or sets these keys by exact match, and prefix invalidation still covers them. The report should be corrected.
2. **Some list hooks don't keep previous data while paging.**
   - Missing `placeholderData: keepPreviousData` in `catalog-api.ts:55-60,101-106`, `orgs-api.ts:29-34` and `users-api.ts:35-40`.
   - Orders, inventory and price lists do use it, so these four lists flash back to the skeleton on every page change. Add it for consistency.
3. **Create pages have no page-level gate.**
   - `/catalog/products/new`, `/catalog/warehouses/new`, `/price-lists/new` and `/organizations/new` render the full form to any role; submitting returns 403.
   - The "New user" button (`users-list-page.tsx:49`) and the user "Edit" button are unconditional. They are only reachable when the list or detail GET succeeded (i.e. admins), so that part is fine.
   - Suggest a small "Not permitted" state using `isOpsAdmin`/`canManageUsers`, so a pasted URL doesn't show a working-looking form.
4. **Buyers can pick an "Inactive only" filter that is always empty.**
   - Where: `products-list-page.tsx:64-72`.
   - The API returns an empty page to non-ops who ask for inactive products (`product.use-cases.ts:51-53`). Hide the active/inactive select when `!isOps(session)`.
5. **The users list looks up org codes it already has.**
   - `users-list-page.tsx:37,113` finds each membership's org in `useOrganizations()`, but `MembershipView` already carries `org_code`.
   - Use `m.org_code`. That drops an extra request and the 8-character id fallback.
6. **Some reference-data failures are hidden.**
   - New-price-list org select (`new-price-list-page.tsx:49-58`): if `useOrganizations` fails, the select silently offers only "Default (all buyers)", so an admin could create a default list by accident.
   - Add-tier product select: the same silent failure.
   - Show `ErrorText` for these failures, as `new-user-page.tsx` does.
7. **Organisations nav is hidden for buyer/buyer_admin, although `GET /organizations` allows them to read their own org.** This is a product call, not a 403 mismatch. `app-layout.tsx:19-21`.
8. **Local filter interfaces re-type the query schemas.**
   - `ProductListFilter` and friends partly restate `List*Query`. This matches wave 1's `OrderListFilter`, so it is acceptable.
   - Deriving them with `Pick<ListProductsQuery, …>` would make drift a compile error.
9. **Adjust-stock quantity isn't range-checked in the client.**
   - `inventory-detail-page.tsx:82-83` accepts any safe integer. The API limit is ±1,000,000, so larger values get a clean 400.
   - Optionally add `min`/`max` on the input.
10. **Self-edit has no guard.**
    - An admin can deactivate or demote themselves from the user form. After a self-demotion, the cached session still shows admin navigation until the next refresh.
    - The backend doesn't stop removal of the last admin either. See Unresolved questions.

## Acceptance checklist

| Item | Verdict |
|---|---|
| Empty/error/loading on every screen | Pass for all list and detail screens. Create forms render `ErrorText`. Gaps in the reference-data selects: Low 6 |
| Dark/light | Pass. Only token classes are used, and Badge tones have `dark:` variants. No hard-coded colours in the new files |
| No horizontal scroll at 375/768/1440 | Pass by code inspection, not checked in a browser. Details below |
| Ledger shows before/after per row | Pass (`ledger-timeline.tsx:45-53,77-78`). Limited by M3 |
| No API types re-declared in the FE | Pass. The contracts change adds 3 type aliases only, with no breaking change |
| Request/response fields and query params match the backend | Pass, except the filter semantics in M1 |
| Money never a float | Pass |
| Role gating matches backend `@Roles`/`assertRole` | Pass for inventory (ops, ops_admin; adjust included), catalog writes (ops_admin), price lists (read: ops; write/archive: ops_admin), org create (ops_admin) and users (ops_admin, buyer_admin). Exception: the H1 edit-path mismatch |
| Wave 1 not broken | Pass. Details below |

Notes on horizontal scroll:
- Every table sits inside the `overflow-x-auto` wrapper from `Table`.
- Fields use `w-full min-w-0`, and `select` shrinks with its container, so grid tracks can't be forced wider.
- The header navigation wraps (`flex-wrap`).

Notes on wave 1:
- `useWarehouses`/`useProducts` are the same queries with the same keys.
- `useOrganizations`/`useQuote` behave the same.
- `api-client`, `auth-store` and the refresh lock are untouched.
- The orders tests pass.

## Scope note

The spec's red-team edit cut "Price-lists CRUD, Orgs & users CRUD". The later user-driven note at the top of the spec (2026-09-18, waves 3-4) explicitly re-adds Catalog + price lists and Orgs + users so that Phases 01 and 02 can be tested. The scope is therefore authorised, and I am not flagging it as scope creep.

## Existing issues, not caused by this change

- `new-order-page.tsx` calls `useQuote(validItems)` without `customer_org_id`. For ops, `quote-prices.use-case.ts:37-39` then throws `customerOrgRequired`. The new optional `customerOrgId` parameter makes this easy to fix.

## Recommended actions (in priority order)

1. H1: send `is_active` only when it changed.
2. H2: add `autoComplete="new-password"`/`"off"` to the admin forms.
3. M2: stop trimming passwords.
4. M1: fix the email filter label, or add a name filter.
5. M3: page the ledger.
6. M5: clear the query cache when the session changes.
7. M4: replace the 100-row reference dropdowns on write paths.
8. Low items as time allows.

## Unresolved questions

1. Should the backend refuse self-deactivation or self-demotion of the last `ops_admin`/`buyer_admin` in an org? If yes, that is a backend change, not in this diff.
2. Should buyers see `base_price` on the Products screen? The price-list copy says "Buyers see prices only through quotes", but the Products list shows list prices to buyers because the API returns them. List price is probably intended to be public. Please confirm.

Status: DONE_WITH_CONCERNS
Summary: The waves 2-4 screens are well built. Gates are green, contracts are used as the single source of types, money is always a string, and wave 1 is intact. Two high-severity defects on the Users forms: the edit form always sends `is_active`, so buyer_admin gets 403 on role changes for shared accounts, and the admin password fields can be autofilled with the admin's own password.
Concerns/Blockers: Fix H1 and H2 before committing. M1-M5 are real functional or privacy gaps (email filter semantics, password trimming, the 100-row ledger and dropdown caps, the query cache surviving logout) and should be fixed or ticketed.
