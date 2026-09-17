# 0011 — One price-resolver port, no resolver chain

**Status:** accepted · 2026-09-18

## Context
StockFlow let the client send the unit price of an order line. v2 decides prices on the
server from per-customer contract lists with quantity tiers. The first plan modelled
this as a chain of resolvers (contract → default list → base price), each trying in turn.
But the base price lives in `products`, a different table from the price lists, so the
chain needs a query per link — and the same plan demanded a fixed query count so that
ordering (which prices a whole cart inside a transaction) cannot turn into N+1.

## Decision
- Keep the **port**, drop the chain. `PriceResolver.resolve(db, scope, customer, lines, at)`
  (`modules/pricing/application/ports/price-resolver.ts`) is the only way anything gets a
  price. Quotes use it now; carts and orders will use the same instance.
- One implementation, `SqlPriceResolver`, runs **two queries whatever the cart size**:
  the products (through `CatalogService`), then every tier that could apply to them for
  this customer. `price-resolver.spec.ts` asserts ≤ 2 and the same count for 1 and 20
  lines.
- The policy is one **pure function**, `pickPrice`, tested without a database:
  1. keep tiers that are active, valid at `at` (`valid_to` exclusive), belong to this
     customer or to the default list, and start at or below `qty`;
  2. choose one list: contract before default, then higher `priority`, newer
     `valid_from`, lower list id — a total order, so row order never matters;
  3. take the largest tier of that list not above `qty` (tiers are never mixed across
     lists);
  4. otherwise the product's base price.
- Every priced line says where its price came from: `source_kind`
  (`contract` / `default_list` / `base_price`), the tier id, the list id and
  `min_qty_applied`. The copilot and the UI explain prices from these fields.
- `resolve` calls `assertOrgInScope(scope, customer)` first. A buyer cannot price for
  another organisation (404); ops can price for any **buyer**, never for the internal
  organisation. Contract lists can only belong to buyers: the database enforces it with
  a composite foreign key `(org_id, org_type) → organizations (id, type)` and
  `org_type = 'buyer'`.

### Differences from the plan
- The result is an **array aligned with the request**, not a `Map` keyed by product —
  callers keep their line order and a line cannot silently go missing.
- The customer is passed as `{ id, type }` so the scope check needs no extra query; the
  use case loads the organisation (scoped) before calling.
- `resolve` takes the `Tx` explicitly, like every repository (ADR 0004).
- Products that are unknown or inactive fail the whole call (`PRODUCT_NOT_FOUND`,
  `PRODUCT_INACTIVE`) instead of being skipped.

## Consequences
- A promotion or campaign source is either a second implementation of the port or one
  more candidate source in the tier query plus a rule in `pickPrice`. Ordering does not
  change either way.
- A tier's price can be changed in place (re-posting the same product and `min_qty`).
  Order lines therefore **copy** the unit price they were charged and keep the tier id
  only to trace where it came from; they never re-read the price through that id.
- Price lists are archived, never deleted, so that tier id keeps resolving to a row.
- Price-list reads take an `OrgScope` like every other organisation-owned table; default
  lists are in every scope. Today only ops read them, but a future "my contract" page
  cannot leak another buyer's list by reusing the repository.
- Buyers see only active products; a discontinued product is 404 to them.
