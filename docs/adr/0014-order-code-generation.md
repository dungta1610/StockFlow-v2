# 0014 — Order codes from a sequence

**Status:** accepted · 2026-09-18

## Context
StockFlow built order codes as `ORD-YYYYMMDD-` plus six random digits and relied on a
`UNIQUE` constraint. By the birthday bound, a collision becomes likely after roughly a
thousand orders in one day. When it happened, the insert failed in the middle of the
order transaction, a 500 for an order that had done nothing wrong.

## Decision
A global sequence behind a SQL function, used as the column default:

```sql
ORD-<date in Asia/Ho_Chi_Minh>-<nextval padded to at least 6 digits>
```

- The sequence is global, not reset daily, so codes are unique however the date is
  computed. The date is only there for people.
- Padding widens instead of truncating once the counter passes 999999. `lpad` would
  silently cut the number off and bring collisions back.
- The function names the sequence with its schema (`commerce.order_code_seq`), so it
  works whatever the caller's `search_path`.
- Sequences are not transactional: a rolled-back order leaves a gap. Gaps are fine. The
  code is an identifier, not an invoice number.

## Consequences
- `order-code.spec.ts` draws 10,000 codes in one statement and asserts that all are
  distinct and well formed.
- Sequential codes can be guessed. Every endpoint that takes an order id or code must
  therefore check scope. It does, through `OrgScope`, and an order outside scope reads
  as 404 (`scope.spec.ts`).
