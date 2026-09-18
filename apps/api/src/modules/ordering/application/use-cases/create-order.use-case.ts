import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../../../platform/config/env.schema';
import type { Tx } from '../../../../platform/database/tx';
import { CatalogService } from '../../../catalog/application/catalog.service';
import { CatalogErrors } from '../../../catalog/domain/errors';
import { type Actor, assertRole } from '../../../identity/domain/actor';
import { orgScopeOf } from '../../../identity/domain/org-scope';
import { InventoryService } from '../../../inventory/application/inventory.service';
import { StockMovementService } from '../../../inventory/application/stock-movement.service';
import { type PricedLine, PriceResolver } from '../../../pricing/application/ports/price-resolver';
import { Money } from '../../../pricing/domain/money';
import { OrderErrors } from '../../domain/errors';
import type { Order, OrderItem, OrderWithItems } from '../../domain/order';
import { OrderRepository } from '../ports/order.repository';
import { OutboxRepository } from '../ports/outbox.repository';
import { type NewReservation, ReservationRepository } from '../ports/reservation.repository';

export interface CreateOrderInput {
  warehouseId: string;
  /** No price: what the buyer pays comes only from the price resolver. */
  items: readonly { productId: string; quantity: number }[];
}

/**
 * Places an order and holds its stock, all in the caller's transaction. StockFlow's
 * CreateOrder inserted the order and committed without touching stock at all.
 *
 *   1. authorise   buyers only, active warehouse
 *   2. price       PriceResolver — anything the client sent as a price never gets here
 *   3. write       order + lines (their rows lock nothing anyone else waits for)
 *   4. reserve     line by line in product-id order; one shortfall throws and the
 *                  transaction rollback undoes every reservation before it
 *   5. record      reservations and the order.created outbox event
 *
 * Stock is reserved last so its row locks are held for as short a time as possible,
 * and always in product-id order so two orders never wait on each other in a cycle.
 * There is no SELECT … FOR UPDATE: each reservation is one conditional UPDATE.
 */
@Injectable()
export class CreateOrderUseCase {
  private readonly holdMs: number;

  constructor(
    private readonly prices: PriceResolver,
    private readonly catalog: CatalogService,
    private readonly movements: StockMovementService,
    private readonly inventory: InventoryService,
    private readonly orders: OrderRepository,
    private readonly reservations: ReservationRepository,
    private readonly outbox: OutboxRepository,
    config: ConfigService<Env, true>,
  ) {
    this.holdMs = config.get('ORDER_RESERVATION_TTL_MINUTES', { infer: true }) * 60_000;
  }

  async execute(tx: Tx, actor: Actor, input: CreateOrderInput, now: Date): Promise<OrderWithItems> {
    assertRole(actor, 'buyer', 'buyer_admin');
    if (actor.orgType !== 'buyer') throw OrderErrors.buyersOnly();
    const lines = normalizeLines(input.items);
    const warehouseId = input.warehouseId.toLowerCase();

    const warehouse = await this.catalog.findWarehouse(tx, warehouseId);
    if (!warehouse) throw CatalogErrors.warehouseNotFound();
    if (!warehouse.isActive) throw OrderErrors.warehouseInactive();

    const priced = await this.prices.resolve(tx, orgScopeOf(actor), { id: actor.orgId, type: 'buyer' }, lines, now);
    const subtotal = priced.reduce((sum, l) => sum.plus(l.lineTotal), Money.ZERO);
    const expiresAt = new Date(now.getTime() + this.holdMs);

    const order = await this.orders.insert(tx, {
      buyerOrgId: actor.orgId,
      placedByUserId: actor.userId,
      warehouseId,
      subtotal,
      total: subtotal,
      reservationExpiresAt: expiresAt,
    });
    const items = await this.orders.insertItems(tx, order.id, priced.map(toNewItem).sort(bySku));

    const held = await this.reserveStock(tx, actor, order, items, expiresAt);
    await this.reservations.insertMany(tx, held);
    await this.outbox.append(tx, {
      aggregateType: 'order',
      aggregateId: order.id,
      eventType: 'order.created',
      orgId: order.buyerOrgId,
      payload: {
        order_id: order.id,
        order_code: order.orderCode,
        buyer_org_id: order.buyerOrgId,
        placed_by_user_id: order.placedByUserId,
        warehouse_id: order.warehouseId,
        total: order.total.toString(),
        currency: order.currency,
        reservation_expires_at: expiresAt.toISOString(),
        items: items.map((i) => ({
          product_id: i.productId,
          sku: i.sku,
          quantity: i.quantity,
          unit_price: i.unitPrice.toString(),
          line_total: i.lineTotal.toString(),
          price_list_item_id: i.priceListItemId,
        })),
      },
    });
    return { ...order, items };
  }

  /** Reserves every line in product-id order; throws INSUFFICIENT_STOCK on the first shortfall. */
  private async reserveStock(
    tx: Tx,
    actor: Actor,
    order: Order,
    items: readonly OrderItem[],
    expiresAt: Date,
  ): Promise<NewReservation[]> {
    const held: NewReservation[] = [];
    for (const item of [...items].sort(byProductId)) {
      // The ledger row written with the movement already points at this reservation;
      // the row itself is inserted once every line is held (the key is deferred).
      const reservationId = randomUUID();
      const move = await this.movements.reserve(
        tx,
        { productId: item.productId, warehouseId: order.warehouseId, qty: item.quantity },
        { orderId: order.id, reservationId, createdBy: actor.userId, reason: `order ${order.orderCode}` },
      );
      if (!move) {
        const level = (await this.inventory.levelsAt(tx, order.warehouseId, [item.productId])).get(item.productId)!;
        throw OrderErrors.insufficientStock({
          product_id: item.productId,
          sku: item.sku,
          requested: item.quantity,
          available: level.available,
        });
      }
      held.push({
        id: reservationId,
        orderId: order.id,
        orderItemId: item.id,
        inventoryId: move.inventoryId,
        productId: item.productId,
        warehouseId: order.warehouseId,
        quantity: item.quantity,
        expiresAt,
      });
    }
    return held;
  }
}

/** Lower-cases ids (Postgres returns them that way) and rejects empty or repeated lines. */
function normalizeLines(items: CreateOrderInput['items']): { productId: string; qty: number }[] {
  if (items.length === 0) throw OrderErrors.emptyOrder();
  const lines = items.map((i) => ({ productId: i.productId.toLowerCase(), qty: i.quantity }));
  if (new Set(lines.map((l) => l.productId)).size !== lines.length) throw OrderErrors.duplicateProduct();
  return lines;
}

const toNewItem = (l: PricedLine) => ({
  productId: l.productId,
  sku: l.sku,
  quantity: l.qty,
  unitPrice: l.unitPrice,
  lineTotal: l.lineTotal,
  priceListItemId: l.sourceId,
});

const byProductId = (a: { productId: string }, b: { productId: string }) =>
  a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;

const bySku = (a: { sku: string }, b: { sku: string }) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
