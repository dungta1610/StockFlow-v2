# 0007 — OrgScope instead of a bare organisation id; memberships

**Status:** accepted · 2026-09-17

## Context
StockFlow (Go) had no organisations. v2 is one supplier selling to many buyer
organisations. Supplier staff (ops) belong to an `internal` organisation, while commerce
data is keyed by `buyer_org_id`. Scoping every query by "the caller's organisation id"
therefore returns nothing for ops staff — the classic fix is an
`if (internal) skip the filter` branch, which silently becomes the tenant boundary for
every caller.

## Decision
- Services that read organisation-owned data take an **`OrgScope`**, never a bare id:
  - `single` — one organisation (every buyer);
  - `all-buyers` — every buyer organisation, never the internal one (ops, commerce data);
  - `all` — every organisation (ops, identity administration: organisations and members).
- `orgScopeOf(actor)` (commerce) and `identityScopeOf(actor)` (identity) derive it.
  Ops rights count only for an actor whose organisation **is** internal.
- One function, `scopeSql`, turns a scope into SQL. `all-buyers` checks the organisation
  *type*, so it cannot match the internal organisation.
- `assertOrgInScope(scope, org)` guards every organisation id that comes from a request
  or from model output; it takes the organisation's type, not only its id.
- Out-of-scope reads return **404**, never 403.
- Users belong to organisations through **`org_members`** (one role per organisation).
  Login takes an optional `org_code`; with exactly one active membership it is inferred,
  with several it is required (`ORG_SELECTION_REQUIRED`, listing the choices only after
  the password has been verified). The access token carries the chosen organisation.
- **Role ↔ organisation type** is enforced in the database with a composite foreign key
  `(org_id, org_type) → organizations (id, type)` plus a `CHECK`.
  *Changed from the plan*, which used a `CHECK` calling a function that reads
  `organizations`: such a check can fail during `pg_dump` restore (data loaded before the
  referenced rows) and does not notice an organisation changing type.
- **Account-level fields** (password, activation, name) of a user may only be changed by
  an admin whose scope covers *every* organisation the user belongs to. Otherwise a
  buyer admin could reset the password of an account shared with another organisation —
  a cross-tenant takeover. Roles are per membership and can be changed within scope.
- A password change or deactivation revokes all of the user's refresh tokens.

## Consequences
- The ops console needs no special-case code to read customer data.
- Forgetting to scope a query is a compile error (the parameter is required).
- The `all` variant is an addition to the plan's two-variant design, needed because
  identity administration must include the internal organisation.
