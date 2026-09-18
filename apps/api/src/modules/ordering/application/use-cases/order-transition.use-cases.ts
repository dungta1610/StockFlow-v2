import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../../platform/database/tx';
import { type Actor, SYSTEM_ACTOR_ID, assertRole } from '../../../identity/domain/actor';
import { orgScopeOf } from '../../../identity/domain/org-scope';
import { StockMovementService } from '../../../inventory/application/stock-movement.service';
import { OrderErrors } from '../../domain/errors';
import type { Order, OrderWithItems } from '../../domain/order';
import { type OrderStatus, canTransition } from '../../domain/order-state-machine';
import { OrderRepository } from '../ports/order.repository';
import { OutboxRepository } from '../ports/outbox.repository';
import { ReservationRepository } from '../ports/reservation.repository';

/** Closed with its stock given back. Asking to close such an order again changes nothing. */
const RELEASED: readonly OrderStatus[] = ['cancelled', 'expired'];

/** What entering a status does to the stock the order holds. */
const STOCK_EFFECT: Partial<Record<OrderStatus, 'release' | 'consume'>> = {
  cancelled: 'release',
  expired: 'release',
  fulfilled: 'consume',
};

/**
 * Moves one order to a new status, in one transaction, all or nothing:
 *
 *   lock the order (FOR UPDATE — the lock is the claim; a second worker waits here)
 *   already in the target status → return it unchanged          (idempotent)
 *   cancel/expire an order already cancelled or expired → return it unchanged: the
 *     caller wanted the hold ended and it is (a buyer's cancel racing the sweep)
 *   transition not allowed       → ORDER_CANNOT_BE_<target>
 *   lock ALL its held reservations, settle each one's stock in product-id order
 *   update the status, write the outbox event
 *
 * There is no intermediate status and no LIMIT inside one order, so a crash leaves
 * either the old state or the new one, never a half-released order. Lock order is the
 * system-wide one: orders → reservations → inventory by product id (code-standards §3).
 */
@Injectable()
export class OrderTransitions {
  constructor(
    private readonly orders: OrderRepository,
    private readonly reservations: ReservationRepository,
    private readonly movements: StockMovementService,
    private readonly outbox: OutboxRepository,
  ) {}

  async apply(tx: Tx, actor: Actor, orderId: string, target: OrderStatus): Promise<OrderWithItems> {
    let order = await this.orders.lockById(tx, orgScopeOf(actor), orderId);
    if (!order) throw OrderErrors.orderNotFound();

    const settled = order.status === target || (RELEASED.includes(target) && RELEASED.includes(order.status));
    if (!settled) {
      if (!canTransition(order.status, target)) throw OrderErrors.cannotTransition(order.status, target);
      const from = order.status;
      await this.settleStock(tx, actor, order, target);
      order = await this.orders.updateStatus(tx, order.id, target);
      await this.outbox.append(tx, {
        aggregateType: 'order',
        aggregateId: order.id,
        eventType: `order.${target}`,
        orgId: order.buyerOrgId,
        payload: {
          order_id: order.id,
          order_code: order.orderCode,
          buyer_org_id: order.buyerOrgId,
          from,
          to: target,
          actor_user_id: actor.userId,
        },
      });
    }
    return { ...order, items: await this.orders.findItems(tx, order.id) };
  }

  private async settleStock(tx: Tx, actor: Actor, order: Order, target: OrderStatus): Promise<void> {
    const effect = STOCK_EFFECT[target];
    if (!effect) return;

    const held = await this.reservations.lockHeld(tx, order.id);
    for (const r of held) {
      const input = { inventoryId: r.inventoryId, qty: r.quantity };
      // systemActor (the reservation-expiry sweep) is not a row in `users`; the
      // ledger's created_by carries a foreign key to it, so a system-driven
      // movement records no created_by rather than a dangling id.
      const createdBy = actor.userId === SYSTEM_ACTOR_ID ? null : actor.userId;
      const ctx = { orderId: order.id, reservationId: r.id, createdBy, reason: `order ${order.orderCode} ${target}` };
      const move =
        effect === 'consume' ? await this.movements.consume(tx, input, ctx) : await this.movements.release(tx, input, ctx);
      // A held reservation is always covered by reserved_qty; if not, the books are
      // already wrong and nothing here may make it worse.
      if (!move) throw new Error(`Reservation ${r.id} holds more than inventory ${r.inventoryId} has reserved`);
    }
    await this.reservations.settle(
      tx,
      held.map((r) => r.id),
      effect === 'consume' ? 'consumed' : 'released',
    );
  }
}

export interface OrderRef {
  orderId: string;
}

/** Buyers cancel their own orders; ops cancel any buyer's. */
@Injectable()
export class CancelOrderUseCase {
  constructor(private readonly transitions: OrderTransitions) {}

  async execute(tx: Tx, actor: Actor, input: OrderRef): Promise<OrderWithItems> {
    assertRole(actor, 'buyer', 'buyer_admin', 'ops', 'ops_admin');
    return this.transitions.apply(tx, actor, input.orderId, 'cancelled');
  }
}

/** Ends a hold whose time is up. Called by the expiry sweep, or by ops by hand. */
@Injectable()
export class ExpireOrderUseCase {
  constructor(private readonly transitions: OrderTransitions) {}

  async execute(tx: Tx, actor: Actor, input: OrderRef): Promise<OrderWithItems> {
    assertRole(actor, 'ops', 'ops_admin');
    return this.transitions.apply(tx, actor, input.orderId, 'expired');
  }
}

/** Records a payment received outside the system; v1 has no payment module. */
@Injectable()
export class MarkOrderPaidUseCase {
  constructor(private readonly transitions: OrderTransitions) {}

  async execute(tx: Tx, actor: Actor, input: OrderRef): Promise<OrderWithItems> {
    assertRole(actor, 'ops', 'ops_admin');
    return this.transitions.apply(tx, actor, input.orderId, 'paid');
  }
}

/** The goods have left: held stock is consumed. */
@Injectable()
export class FulfillOrderUseCase {
  constructor(private readonly transitions: OrderTransitions) {}

  async execute(tx: Tx, actor: Actor, input: OrderRef): Promise<OrderWithItems> {
    assertRole(actor, 'ops', 'ops_admin');
    return this.transitions.apply(tx, actor, input.orderId, 'fulfilled');
  }
}
