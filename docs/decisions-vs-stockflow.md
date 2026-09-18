# Decisions vs StockFlow (Go)

What v2 ports from `StockFlow` unchanged, what it changes on purpose, and why. Every
difference here is deliberate; a difference that is not listed is a bug.

## Ordering

Source: `module/order/storage/sql_order_tx.go` (`CreateOrder`, `CancelOrder`,
`ExpireOrder`, `generateOrderCode`), `module/order/model/*`,
`module/inventory/model/inventory_reservation.go`.

### Ported as is
| StockFlow | v2 |
|---|---|
| Routes `POST /orders`, `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel`, `POST /orders/:id/expire` | same paths |
| `SELECT … FOR UPDATE` on the order before cancel/expire | same: the order row lock is the first lock and the claim |
| Refusals: paid / fulfilled / completed / expired cannot be cancelled; paid / cancelled / fulfilled / completed cannot be expired | same rules, now a table in `order-state-machine.ts` |
| Eight statuses in the enum | the `CHECK` constraint accepts all eight |
| `order_code` format `ORD-YYYYMMDD-NNNNNN` | same shape |
| List filters: order code, warehouse, status; newest first; page/limit paging | same, plus `buyer_org_id` for ops |
| Validation: items required, quantity > 0 | same, plus "each product once" |

### Changed on purpose
| StockFlow | v2 | Why |
|---|---|---|
| `CreateOrder` never touched stock; `inventory_reservations` had no caller | every line reserves stock with a conditional update in the order's transaction; one shortfall rolls the whole order back | oversell was possible (ADR 0013) |
| Cancel / expire only changed the status | they release every held reservation; fulfil consumes them | stock stayed held forever |
| Client sent `unit_price`; `line_total = unit_price × qty` | no price field in the request; prices come from `PriceResolver`, each line records `price_list_item_id` | a buyer chose their own price (ADR 0011) |
| `float64` money, `total_amount` | `numeric(18,2)` / `Money`; `subtotal` and `total` | floats cannot hold money exactly (ADR 0010) |
| `RANDOM()` six digits + `UNIQUE` | global sequence, padding that widens | collisions failed transactions (ADR 0014) |
| `user_id` on the order, no tenant | `buyer_org_id` + `placed_by_user_id`, every read through `OrgScope`; out-of-scope reads are 404 | multi-tenant B2B |
| `pending` when `reservation_expires_at` was nil | never produced; hold length is server config (`ORDER_RESERVATION_TTL_MINUTES`), not client input | every order holds stock (ADR 0016) |
| `awaiting_payment`, `completed` in the flow | never produced; `mark-paid` records payment | payment module cut (ADR 0016) |
| Cancel twice → `ErrOrderAlreadyCancelled`; expire twice → `ErrOrderAlreadyExpired`; cancel an expired order → `ErrOrderCannotBeCancelled` | repeating a transition returns the order unchanged, 200; so does cancelling an expired order or expiring a cancelled one | cancel / expire / fulfil / mark-paid must be safe to retry, and a buyer's cancel may race the expiry sweep |
| Order not found on cancel → `nil, nil` | `404 ORDER_NOT_FOUND` | a silent nil hid the failure |
| No idempotency | `Idempotency-Key` on create; claim committed first, key freed on failure | retries after a timeout must not double-order (ADR 0015) |
| No events | `outbox_events` row in the same transaction as every change | reliable hand-off to phase 05 |
| — | reservation statuses are only `held / released / consumed` | an intermediate "releasing" state could strand stock after a crash |
