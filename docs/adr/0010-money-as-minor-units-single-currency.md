# 0010 — Money as integer minor units, one currency

**Status:** accepted · 2026-09-18

## Context
StockFlow (Go) stored and computed prices as `float64`. `0.1 + 0.2` style errors are
rare in a demo and expensive in invoices, and they cross every layer: the database, the
API, the web app and anything an agent reads. Multi-currency support done halfway
(a `currency` column that nothing checks) is worse than none — sums across currencies
fail somewhere in the middle of a transaction instead of at the edge.

## Decision
- **Database:** `numeric(18,2)` for every amount. `pg` returns `numeric` as a string by
  default; nothing overrides that parser (pinned by `pricing-constraints.spec.ts`, which
  round-trips `9999999999999999.99`).
- **Application:** `Money` (`modules/pricing/domain/money.ts`) holds a `bigint` of minor
  units (hundredths). Constructors:
  - `Money.parse(string)` for API input — `^\d{1,16}(\.\d{1,2})?$`, never a JS number;
  - `Money.fromDb(string)` for `numeric` values (also accepts trailing zeros and a sign);
  - `Money.fromMinor(bigint)`.

  Arithmetic is `plus` and `times(qty)` (integer quantity only). `toString()` always
  prints two decimals (`"65000.50"`). An invalid amount from a caller is a
  `400 INVALID_AMOUNT` domain error, whether it arrives over HTTP or from a job or agent
  tool.
- **API / contracts:** amounts are **decimal strings** (`moneySchema`). A JSON number is
  rejected with 400, including `65000.5`.
- **One currency (VND)** in v1, enforced by `CHECK (currency = 'VND')` on `products` and
  `price_lists`. `Money` therefore carries no currency; responses still include
  `currency: "VND"` so clients do not have to change when that is relaxed.
- VND has no minor unit in practice; two decimals are kept anyway so the schema does not
  change when a currency with cents is added.

## Consequences
- Multi-currency = drop the `CHECK`, add a currency to `Money`, and refuse arithmetic
  across currencies. One migration plus one class, not a data clean-up.
- Field renamed: StockFlow's `price` is `base_price` — the list price. What a buyer pays
  comes from the price resolver (ADR 0011).
- Rule enforced by review and a grep gate:
  `grep -rniE "(price|amount|total|subtotal)\s*:\s*number" apps/api/src packages/*/src apps/web/src`
  (case-insensitive, so `basePrice: number` is caught too)
  must stay empty.
