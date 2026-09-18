import { Injectable } from '@nestjs/common';
import { type Paging, pagingSql, paramBinder } from '../../../platform/database/sql';
import type { Tx } from '../../../platform/database/tx';
import type { OrgScope } from '../../identity/domain/org-scope';
import { scopeSql } from '../../identity/infrastructure/scope-sql';
import { Money } from '../../pricing/domain/money';
import { type NewOrder, type NewOrderItem, OrderRepository } from '../application/ports/order.repository';
import type { Order, OrderFilter, OrderItem, OrderWithItems } from '../domain/order';
import { INITIAL_ORDER_STATUS, type OrderStatus } from '../domain/order-state-machine';

interface OrderRow {
  id: string;
  order_code: string;
  buyer_org_id: string;
  placed_by_user_id: string;
  warehouse_id: string;
  status: OrderStatus;
  subtotal: string;
  total: string;
  currency: string;
  reservation_expires_at: Date | null;
  paid_at: Date | null;
  cancelled_at: Date | null;
  expired_at: Date | null;
  fulfilled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  id: string;
  order_id: string;
  product_id: string;
  sku: string;
  quantity: number;
  unit_price: string;
  line_total: string;
  price_list_item_id: string | null;
  created_at: Date;
}

const ORDER_COLUMNS = `o.id, o.order_code, o.buyer_org_id, o.placed_by_user_id, o.warehouse_id, o.status,
  o.subtotal, o.total, o.currency, o.reservation_expires_at, o.paid_at, o.cancelled_at,
  o.expired_at, o.fulfilled_at, o.created_at, o.updated_at`;

const ITEM_SELECT = `
  SELECT oi.id, oi.order_id, oi.product_id, p.sku, oi.quantity, oi.unit_price, oi.line_total,
         oi.price_list_item_id, oi.created_at
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id`;

/** The timestamp each status stamps when an order enters it. */
const STATUS_STAMP: Partial<Record<OrderStatus, string>> = {
  paid: 'paid_at',
  cancelled: 'cancelled_at',
  expired: 'expired_at',
  fulfilled: 'fulfilled_at',
};

const toOrder = (r: OrderRow): Order => ({
  id: r.id,
  orderCode: r.order_code,
  buyerOrgId: r.buyer_org_id,
  placedByUserId: r.placed_by_user_id,
  warehouseId: r.warehouse_id,
  status: r.status,
  subtotal: Money.fromDb(r.subtotal),
  total: Money.fromDb(r.total),
  currency: r.currency,
  reservationExpiresAt: r.reservation_expires_at,
  paidAt: r.paid_at,
  cancelledAt: r.cancelled_at,
  expiredAt: r.expired_at,
  fulfilledAt: r.fulfilled_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toItem = (r: ItemRow): OrderItem => ({
  id: r.id,
  orderId: r.order_id,
  productId: r.product_id,
  sku: r.sku,
  quantity: r.quantity,
  unitPrice: Money.fromDb(r.unit_price),
  lineTotal: Money.fromDb(r.line_total),
  priceListItemId: r.price_list_item_id,
  createdAt: r.created_at,
});

/** Orders scope on their own columns: buyer_org_type is a copy of the organisation type. */
const orderScope = (scope: OrgScope, params: unknown[]) =>
  scopeSql(scope, { id: 'o.buyer_org_id', type: 'o.buyer_org_type' }, params);

@Injectable()
export class SqlOrderRepository extends OrderRepository {
  async insert(tx: Tx, order: NewOrder): Promise<Order> {
    const [row] = await tx.query<OrderRow>(
      `INSERT INTO orders AS o
         (buyer_org_id, placed_by_user_id, warehouse_id, status, subtotal, total, reservation_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${ORDER_COLUMNS}`,
      [
        order.buyerOrgId,
        order.placedByUserId,
        order.warehouseId,
        INITIAL_ORDER_STATUS,
        order.subtotal.toString(),
        order.total.toString(),
        order.reservationExpiresAt,
      ],
    );
    return toOrder(row!);
  }

  async insertItems(tx: Tx, orderId: string, items: readonly NewOrderItem[]): Promise<OrderItem[]> {
    const rows = await tx.query<Omit<ItemRow, 'sku'>>(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price, line_total, price_list_item_id)
       SELECT $1, * FROM unnest($2::uuid[], $3::int[], $4::numeric[], $5::numeric[], $6::uuid[])
       RETURNING id, order_id, product_id, quantity, unit_price, line_total, price_list_item_id, created_at`,
      [
        orderId,
        items.map((i) => i.productId),
        items.map((i) => i.quantity),
        items.map((i) => i.unitPrice.toString()),
        items.map((i) => i.lineTotal.toString()),
        items.map((i) => i.priceListItemId),
      ],
    );
    // An order holds each product once, so the product id identifies the inserted row.
    const byProduct = new Map(rows.map((r) => [r.product_id, r]));
    return items.map((i) => toItem({ ...byProduct.get(i.productId)!, sku: i.sku }));
  }

  async lockById(tx: Tx, scope: OrgScope, id: string): Promise<Order | null> {
    const params: unknown[] = [id];
    const [row] = await tx.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders o
        WHERE o.id = $1 AND ${orderScope(scope, params)}
          FOR UPDATE`,
      params,
    );
    return row ? toOrder(row) : null;
  }

  async updateStatus(tx: Tx, id: string, status: OrderStatus): Promise<Order> {
    const stamp = STATUS_STAMP[status];
    const [row] = await tx.query<OrderRow>(
      `UPDATE orders AS o
          SET status = $2, updated_at = now()${stamp ? `, ${stamp} = now()` : ''}
        WHERE o.id = $1
       RETURNING ${ORDER_COLUMNS}`,
      [id, status],
    );
    if (!row) throw new Error(`Order ${id} disappeared while locked`);
    return toOrder(row);
  }

  async findItems(tx: Tx, orderId: string): Promise<OrderItem[]> {
    const rows = await tx.query<ItemRow>(`${ITEM_SELECT} WHERE oi.order_id = $1 ORDER BY p.sku`, [orderId]);
    return rows.map(toItem);
  }

  async findById(tx: Tx, scope: OrgScope, id: string): Promise<OrderWithItems | null> {
    const [order] = await this.select(tx, scope, 'o.id = $1', [id]);
    return order ?? null;
  }

  async findByCode(tx: Tx, scope: OrgScope, orderCode: string): Promise<OrderWithItems | null> {
    const [order] = await this.select(tx, scope, 'o.order_code = $1', [orderCode]);
    return order ?? null;
  }

  async list(tx: Tx, scope: OrgScope, filter: OrderFilter, paging: Paging): Promise<OrderWithItems[]> {
    const params: unknown[] = [];
    const bind = paramBinder(params);
    const where = ['TRUE'];
    if (filter.status) where.push(`o.status = ${bind(filter.status)}`);
    if (filter.orderCode) where.push(`o.order_code = ${bind(filter.orderCode)}`);
    if (filter.warehouseId) where.push(`o.warehouse_id = ${bind(filter.warehouseId)}`);
    if (filter.buyerOrgId) where.push(`o.buyer_org_id = ${bind(filter.buyerOrgId)}`);
    return this.select(tx, scope, where.join(' AND '), params, `ORDER BY o.created_at DESC, o.id DESC`, paging);
  }

  /** Orders matching `where` inside `scope`, each with its lines — two queries in all. */
  private async select(
    tx: Tx,
    scope: OrgScope,
    where: string,
    params: unknown[],
    orderBy = '',
    paging?: Paging,
  ): Promise<OrderWithItems[]> {
    const scoped = orderScope(scope, params);
    const page = paging ? pagingSql(paging, params) : '';
    const orders = (
      await tx.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders o WHERE ${where} AND ${scoped} ${orderBy} ${page}`, params)
    ).map(toOrder);
    if (orders.length === 0) return [];

    const items = await tx.query<ItemRow>(`${ITEM_SELECT} WHERE oi.order_id = ANY($1::uuid[]) ORDER BY p.sku`, [
      orders.map((o) => o.id),
    ]);
    const byOrder = new Map<string, OrderItem[]>(orders.map((o) => [o.id, []]));
    for (const row of items) byOrder.get(row.order_id)!.push(toItem(row));
    return orders.map((o) => ({ ...o, items: byOrder.get(o.id)! }));
  }
}
