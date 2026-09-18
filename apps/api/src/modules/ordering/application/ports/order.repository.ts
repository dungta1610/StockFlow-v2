import type { Paging } from '../../../../platform/database/sql';
import type { Tx } from '../../../../platform/database/tx';
import type { OrgScope } from '../../../identity/domain/org-scope';
import type { Money } from '../../../pricing/domain/money';
import type { Order, OrderFilter, OrderItem, OrderWithItems } from '../../domain/order';
import type { OrderStatus } from '../../domain/order-state-machine';

export interface NewOrder {
  buyerOrgId: string;
  placedByUserId: string;
  warehouseId: string;
  subtotal: Money;
  total: Money;
  reservationExpiresAt: Date;
}

export interface NewOrderItem {
  productId: string;
  sku: string;
  quantity: number;
  unitPrice: Money;
  lineTotal: Money;
  priceListItemId: string | null;
}

/** Every read takes an OrgScope: an order outside it does not exist for the caller. */
export abstract class OrderRepository {
  /** Inserts a new order in the initial status; the database assigns id and code. */
  abstract insert(tx: Tx, order: NewOrder): Promise<Order>;

  /** Returned in the order given. */
  abstract insertItems(tx: Tx, orderId: string, items: readonly NewOrderItem[]): Promise<OrderItem[]>;

  /**
   * Reads the order `FOR UPDATE`. Every status change starts here, so the order row
   * lock is always the first lock taken and doubles as the claim on the order.
   */
  abstract lockById(tx: Tx, scope: OrgScope, id: string): Promise<Order | null>;

  /** Moves the order to `status` and stamps the matching `*_at` column. */
  abstract updateStatus(tx: Tx, id: string, status: OrderStatus): Promise<Order>;

  abstract findItems(tx: Tx, orderId: string): Promise<OrderItem[]>;

  abstract findById(tx: Tx, scope: OrgScope, id: string): Promise<OrderWithItems | null>;

  abstract findByCode(tx: Tx, scope: OrgScope, orderCode: string): Promise<OrderWithItems | null>;

  /** Newest first. */
  abstract list(tx: Tx, scope: OrgScope, filter: OrderFilter, paging: Paging): Promise<OrderWithItems[]>;

  /**
   * Up to `limit` `reserved` orders whose hold expired before `before`, soonest
   * first, optionally resuming just past `after` — read outside any transaction the
   * caller holds (docs/adr/0018): the reservation sweep locks each order one at a
   * time, in its own transaction, never all of them in the transaction that read
   * this list.
   *
   * `after` is what keeps a persistently failing order from crowding out every
   * order behind it across repeated sweeps: the caller advances it past whatever it
   * touched, pass or fail, and only resets to the start once a sweep reaches the
   * end of the currently expired set.
   */
  abstract listReservedExpired(
    db: Tx,
    before: Date,
    limit: number,
    after?: ExpiryCursor | null,
  ): Promise<ExpiredReservation[]>;
}

export interface ExpiryCursor {
  expiresAt: Date;
  id: string;
}

export interface ExpiredReservation {
  id: string;
  reservationExpiresAt: Date;
}
