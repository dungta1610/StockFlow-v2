import { DomainError, badRequest, forbidden } from '../../../platform/errors/domain-error';
import type { OrderStatus } from './order-state-machine';

/** What a buyer needs to fix the line that could not be reserved. */
export interface InsufficientStockDetails {
  product_id: string;
  sku: string;
  requested: number;
  available: number;
}

const TRANSITION_CODES: Partial<Record<OrderStatus, string>> = {
  paid: 'ORDER_CANNOT_BE_PAID',
  fulfilled: 'ORDER_CANNOT_BE_FULFILLED',
  cancelled: 'ORDER_CANNOT_BE_CANCELLED',
  expired: 'ORDER_CANNOT_BE_EXPIRED',
};

/** Ordering failures. Codes are part of the public API contract. */
export const OrderErrors = {
  orderNotFound: () => new DomainError('ORDER_NOT_FOUND', 'Order not found.', 404),
  buyersOnly: () => forbidden('Only buyer organisations place orders.'),
  emptyOrder: () => badRequest('ORDER_ITEMS_REQUIRED', 'An order needs at least one item.'),
  duplicateProduct: () => badRequest('DUPLICATE_PRODUCT', 'Each product may appear only once in an order.'),
  warehouseInactive: () => badRequest('WAREHOUSE_INACTIVE', 'This warehouse does not take orders.'),
  insufficientStock: (details: InsufficientStockDetails) =>
    new DomainError('INSUFFICIENT_STOCK', `Not enough stock for ${details.sku}.`, 409, details),
  cannotTransition: (from: OrderStatus, to: OrderStatus) =>
    new DomainError(
      TRANSITION_CODES[to] ?? 'ORDER_INVALID_STATUS_TRANSITION',
      `An order that is ${from} cannot become ${to}.`,
      409,
      { status: from },
    ),
  idempotencyKeyReused: () =>
    new DomainError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request.',
      409,
    ),
  idempotencyInProgress: () =>
    new DomainError(
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this Idempotency-Key is still being processed. Retry shortly.',
      409,
      undefined,
      { 'Retry-After': '1' },
    ),
};
