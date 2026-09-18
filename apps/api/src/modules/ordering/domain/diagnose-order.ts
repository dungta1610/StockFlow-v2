import { type OrderStatus, nextStatuses } from './order-state-machine';

/** One order line next to the stock its warehouse has right now. */
export interface LineStock {
  productId: string;
  sku: string;
  quantity: number;
  available: number;
}

/** Why an order is not moving, in terms a person (or the copilot) can act on. */
export type OrderBlocker =
  /** Holding stock; ops must record the payment (mark-paid). */
  | { kind: 'awaiting_payment' }
  /** The hold ends soon; after that the expiry sweep releases the stock. */
  | { kind: 'reservation_expiring'; expiresAt: Date; minutesLeft: number }
  /** The hold has ended but the sweep has not released it yet. */
  | { kind: 'reservation_overdue'; expiresAt: Date }
  /** Paid; ops must fulfil it. */
  | { kind: 'awaiting_fulfilment' }
  /** The order is closed without shipping; its stock went back. */
  | { kind: 'closed'; status: OrderStatus }
  /** Placing this line again today would fail: the warehouse has less than it needs. */
  | { kind: 'insufficient_stock'; productId: string; sku: string; requested: number; available: number };

export interface OrderDiagnosis {
  nextStatuses: readonly OrderStatus[];
  blockers: OrderBlocker[];
}

/**
 * Explains an order from facts alone. Pure, so every rule is tested without a
 * database. A hold counts as "expiring" once fewer than `expiringWithinMinutes` remain.
 */
export function diagnoseOrder(
  order: { status: OrderStatus; reservationExpiresAt: Date | null },
  lines: readonly LineStock[],
  now: Date,
  expiringWithinMinutes = 60,
): OrderDiagnosis {
  const blockers: OrderBlocker[] = [];
  switch (order.status) {
    case 'reserved': {
      blockers.push({ kind: 'awaiting_payment' });
      const expiresAt = order.reservationExpiresAt;
      if (expiresAt) {
        const minutesLeft = Math.floor((expiresAt.getTime() - now.getTime()) / 60_000);
        if (expiresAt.getTime() <= now.getTime()) {
          blockers.push({ kind: 'reservation_overdue', expiresAt });
        } else if (minutesLeft < expiringWithinMinutes) {
          blockers.push({ kind: 'reservation_expiring', expiresAt, minutesLeft });
        }
      }
      break;
    }
    case 'paid':
      blockers.push({ kind: 'awaiting_fulfilment' });
      break;
    case 'cancelled':
    case 'expired':
      blockers.push({ kind: 'closed', status: order.status });
      for (const line of lines) {
        if (line.available < line.quantity) {
          blockers.push({
            kind: 'insufficient_stock',
            productId: line.productId,
            sku: line.sku,
            requested: line.quantity,
            available: line.available,
          });
        }
      }
      break;
    default:
      break;
  }
  return { nextStatuses: nextStatuses(order.status), blockers };
}
