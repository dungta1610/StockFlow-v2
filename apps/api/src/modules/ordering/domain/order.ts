import type { Money } from '../../pricing/domain/money';
import type { OrderStatus } from './order-state-machine';

// Orders, ported from StockFlow module/order/model. Money is Money, never a float.

export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  sku: string;
  quantity: number;
  unitPrice: Money;
  lineTotal: Money;
  /** The price-list tier that priced the line; null when the base price applied. */
  priceListItemId: string | null;
  createdAt: Date;
}

export interface Order {
  id: string;
  orderCode: string;
  buyerOrgId: string;
  placedByUserId: string;
  warehouseId: string;
  status: OrderStatus;
  subtotal: Money;
  total: Money;
  currency: string;
  reservationExpiresAt: Date | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  expiredAt: Date | null;
  fulfilledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderWithItems extends Order {
  items: OrderItem[];
}

export const RESERVATION_STATUSES = ['held', 'released', 'consumed'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Stock one order line holds in its warehouse. */
export interface Reservation {
  id: string;
  orderId: string;
  orderItemId: string;
  inventoryId: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  status: ReservationStatus;
  expiresAt: Date | null;
  reservedAt: Date;
  releasedAt: Date | null;
  consumedAt: Date | null;
}

export interface OrderFilter {
  status?: OrderStatus;
  orderCode?: string;
  warehouseId?: string;
  buyerOrgId?: string;
}
