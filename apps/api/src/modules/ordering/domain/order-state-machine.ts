/**
 * The order lifecycle as data. StockFlow spread these rules over `switch` statements
 * inside its storage layer; here they are one table that the HTTP use cases, the
 * expiry sweep and the copilot all read.
 *
 * The database accepts all eight StockFlow statuses, but v1 only produces five:
 *
 *   create ──► reserved ──► paid ──► fulfilled
 *                 │
 *                 ├──► cancelled
 *                 └──► expired
 *
 * `pending` (StockFlow's "no reservation" state — every v2 order holds stock),
 * `awaiting_payment` (belongs to the payment module that was cut) and `completed`
 * have no way in.
 */
export const ORDER_STATUSES = [
  'pending',
  'reserved',
  'awaiting_payment',
  'paid',
  'fulfilled',
  'completed',
  'cancelled',
  'expired',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The status a new order is created in. */
export const INITIAL_ORDER_STATUS: OrderStatus = 'reserved';

// Kept from StockFlow: paid / fulfilled / completed / expired orders cannot be
// cancelled; paid / cancelled / fulfilled / completed orders cannot be expired.
const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: [],
  reserved: ['paid', 'cancelled', 'expired'],
  awaiting_payment: [],
  paid: ['fulfilled'],
  fulfilled: [],
  completed: [],
  cancelled: [],
  expired: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Where an order in `status` may go next. */
export function nextStatuses(status: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[status];
}

/** No transition leaves these statuses. */
export function isFinal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
