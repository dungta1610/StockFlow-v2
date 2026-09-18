# 0016 — Order lifecycle without a payment module

**Status:** accepted · 2026-09-18

## Context
StockFlow's order enum has eight statuses. The simulated payment module (phase 06) was
cut, and an earlier plan still drew all eight and asked the UI to render them, although
three have no code path that produces them. Payment still has to be recorded somehow
before an order can ship.

## Decision
**The database accepts all eight statuses; v1 produces five.**

```
 create ──► reserved ──► paid ──► fulfilled
               ├──► cancelled
               └──► expired
```

| Status | Produced in v1 | Why |
|---|---|---|
| `reserved`, `paid`, `fulfilled`, `cancelled`, `expired` | yes | the live path |
| `pending` | no | StockFlow's "no reservation" state; every v2 order holds stock |
| `awaiting_payment` | no | belonged to the payment module that was cut |
| `completed` | no | v1.1 |

The transitions are a table in `order-state-machine.ts`, a pure function that
`state-machine.spec.ts` checks for every (from, to) pair, including that the three unused
statuses have no way in. StockFlow's refusals are kept: a paid, fulfilled, completed or
expired order cannot be cancelled, and a paid, cancelled, fulfilled or completed order
cannot be expired.

**`POST /orders/:id/mark-paid` stands in for payment.** It is ops-only and records money
received outside the system. Paying moves no stock: the units stay held until
`fulfill` consumes them.

**Every transition is idempotent and writes an outbox event** (`order.paid`,
`order.cancelled`, …) in its own transaction. Repeating a transition to the status the
order is already in returns it unchanged and writes nothing. So does cancelling an
expired order or expiring a cancelled one: either way the hold is over and the stock is
back, which is all the caller asked for, and a buyer's cancel may race the expiry sweep.
Any other disallowed
transition is a 409 named after the target (`ORDER_CANNOT_BE_CANCELLED`, …) and reports
the current status. Events carry the buyer organisation as `org_id`, even when ops acted.

**Who may do what:** buyers place orders and cancel their own; ops cancel, expire,
mark-paid and fulfil any buyer's order. Each use case checks this itself, since the
expiry sweep and the copilot call use cases without HTTP.

## Consequences
- The UI renders five statuses, not eight.
- Adding real payments later means an `awaiting_payment` edge and a payment module that
  calls the same transition code. The database already accepts the status.
