import type { Tx } from '../../../../platform/database/tx';
import type { OrgScope } from '../../../identity/domain/org-scope';
import type { Reservation } from '../../domain/order';

export interface NewReservation {
  /** Chosen by the caller: the ledger row of the reserve movement already points at it. */
  id: string;
  orderId: string;
  orderItemId: string;
  inventoryId: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  expiresAt: Date;
}

/** A held reservation of a `reserved` order, with what a person needs to act on it. */
export interface ExpiringReservation extends Reservation {
  orderCode: string;
  buyerOrgId: string;
  sku: string;
}

export abstract class ReservationRepository {
  abstract insertMany(tx: Tx, rows: readonly NewReservation[]): Promise<void>;

  /**
   * Every `held` reservation of the order, locked, ordered by product id — the order
   * in which their stock rows are then touched. No LIMIT: a status change settles
   * the whole order or nothing. Call only while holding the order's row lock.
   */
  abstract lockHeld(tx: Tx, orderId: string): Promise<Reservation[]>;

  abstract settle(tx: Tx, ids: readonly string[], status: 'released' | 'consumed'): Promise<void>;

  abstract listByOrder(tx: Tx, orderId: string): Promise<Reservation[]>;

  /** Held reservations of `reserved` orders expiring before `until`, soonest first. */
  abstract listExpiring(tx: Tx, scope: OrgScope, until: Date, limit: number): Promise<ExpiringReservation[]>;
}
