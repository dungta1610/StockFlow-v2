import { Injectable } from '@nestjs/common';
import type { Paging } from '../../../platform/database/sql';
import type { Tx } from '../../../platform/database/tx';
import type { OrgScope } from '../../identity/domain/org-scope';
import { InventoryService } from '../../inventory/application/inventory.service';
import { type OrderDiagnosis, diagnoseOrder } from '../domain/diagnose-order';
import { OrderErrors } from '../domain/errors';
import type { OrderFilter, OrderWithItems, Reservation } from '../domain/order';
import { OrderRepository } from './ports/order.repository';
import { ReservationRepository } from './ports/reservation.repository';

export interface OrderReport extends OrderDiagnosis {
  order: OrderWithItems;
  reservations: Reservation[];
}

/**
 * Reading orders — for the HTTP API and the copilot alike. Every method takes the
 * caller's OrgScope first: an order outside it reads as "not found", never as
 * "forbidden", so its existence is not confirmed either.
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly reservations: ReservationRepository,
    private readonly inventory: InventoryService,
  ) {}

  list(db: Tx, scope: OrgScope, filter: OrderFilter, paging: Paging): Promise<OrderWithItems[]> {
    return this.orders.list(db, scope, filter, paging);
  }

  async get(db: Tx, scope: OrgScope, id: string): Promise<OrderWithItems> {
    const order = await this.orders.findById(db, scope, id);
    if (!order) throw OrderErrors.orderNotFound();
    return order;
  }

  /**
   * Why an order is where it is and what would move it on: its holds, the next
   * statuses, and — for a closed order — which lines stock could no longer cover.
   * Takes the order code people read off documents.
   */
  async diagnose(db: Tx, scope: OrgScope, orderCode: string, now = new Date()): Promise<OrderReport> {
    const order = await this.orders.findByCode(db, scope, orderCode.trim().toUpperCase());
    if (!order) throw OrderErrors.orderNotFound();

    const [reservations, levels] = await Promise.all([
      this.reservations.listByOrder(db, order.id),
      this.inventory.levelsAt(
        db,
        order.warehouseId,
        order.items.map((i) => i.productId),
      ),
    ]);
    const lines = order.items.map((i) => ({
      productId: i.productId,
      sku: i.sku,
      quantity: i.quantity,
      available: levels.get(i.productId)!.available,
    }));
    return { order, reservations, ...diagnoseOrder(order, lines, now) };
  }
}
