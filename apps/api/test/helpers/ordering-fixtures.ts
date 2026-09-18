import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Actor } from '../../src/modules/identity/domain/actor';
import { AdjustStockUseCase } from '../../src/modules/inventory/application/use-cases/adjust-stock.use-case';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { withDb, type Tenants } from './identity-fixtures';

/** The actors of `seedTenants()`, for tests that call use cases directly. */
export function actorsOf(t: Tenants) {
  return {
    ops: { userId: t.users.ops, orgId: t.internal, orgType: 'internal', roles: ['ops'] } as Actor,
    opsAdmin: { userId: t.users.opsAdmin, orgId: t.internal, orgType: 'internal', roles: ['ops_admin'] } as Actor,
    buyerA: { userId: t.users.buyerA, orgId: t.buyerA, orgType: 'buyer', roles: ['buyer'] } as Actor,
    buyerB: { userId: t.users.buyerB, orgId: t.buyerB, orgType: 'buyer', roles: ['buyer'] } as Actor,
  };
}

/** Adds stock the way ops do, so every unit has its ledger row. */
export async function stockUp(
  app: INestApplication,
  t: Tenants,
  productId: string,
  warehouseId: string,
  quantity: number,
): Promise<void> {
  const uow = app.get(UnitOfWork);
  const adjust = app.get(AdjustStockUseCase);
  await uow.withTransaction((tx) =>
    adjust.execute(tx, actorsOf(t).ops, { productId, warehouseId, quantity, reason: 'test stock' }),
  );
}

export interface OrderBody {
  warehouse_id: string;
  items: { product_id: string; quantity: number; [extra: string]: unknown }[];
  [extra: string]: unknown;
}

export function postOrder(server: unknown, auth: string, body: OrderBody, idempotencyKey?: string) {
  const req = request(server as never).post('/orders').set('Authorization', auth);
  if (idempotencyKey !== undefined) req.set('Idempotency-Key', idempotencyKey);
  return req.send(body);
}

export function orderAction(server: unknown, auth: string, orderId: string, action: string) {
  return request(server as never).post(`/orders/${orderId}/${action}`).set('Authorization', auth);
}

export interface StockRow {
  available_qty: number;
  reserved_qty: number;
}

export function stockOf(productId: string, warehouseId: string): Promise<StockRow> {
  return withDb(async (pg) => {
    const { rows } = await pg.query<StockRow>(
      'SELECT available_qty, reserved_qty FROM commerce.inventory WHERE product_id = $1 AND warehouse_id = $2',
      [productId, warehouseId],
    );
    return rows[0] ?? { available_qty: 0, reserved_qty: 0 };
  });
}

/** Row counts of every table an order writes to. */
export function orderFootprint(): Promise<Record<string, number>> {
  return withDb(async (pg) => {
    const count = async (sql: string) => Number((await pg.query<{ n: string }>(sql)).rows[0]!.n);
    return {
      orders: await count('SELECT count(*) AS n FROM commerce.orders'),
      order_items: await count('SELECT count(*) AS n FROM commerce.order_items'),
      reservations: await count('SELECT count(*) AS n FROM commerce.inventory_reservations'),
      order_ledger: await count(
        "SELECT count(*) AS n FROM commerce.inventory_transactions WHERE txn_type <> 'manual_adjustment'",
      ),
      outbox: await count('SELECT count(*) AS n FROM commerce.outbox_events'),
    };
  });
}

/** Postgres error codes that must never appear: deadlock and lock-wait timeout. */
export const LOCK_FAILURES = ['40P01', '55P03'];

export const pgCodeOf = (err: unknown): string | undefined => (err as { code?: string })?.code;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Small deterministic PRNG, so a failing random run can be replayed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every rule that ties stock, reservations, orders and the ledger together. Returns
 * the violations; an empty list means the books balance.
 */
export function stockInvariantViolations(): Promise<unknown[]> {
  return withDb(async (pg) => {
    const violations: unknown[] = [];
    const check = async (name: string, sql: string) => {
      for (const row of (await pg.query(sql)).rows) violations.push({ rule: name, ...row });
    };
    await check(
      'reserved_qty equals the held reservations',
      `SELECT i.id, i.reserved_qty,
              coalesce(sum(r.quantity) FILTER (WHERE r.status = 'held'), 0)::int AS held
         FROM commerce.inventory i
         LEFT JOIN commerce.inventory_reservations r ON r.inventory_id = i.id
        GROUP BY i.id
       HAVING i.reserved_qty <> coalesce(sum(r.quantity) FILTER (WHERE r.status = 'held'), 0)`,
    );
    await check(
      'the ledger adds up to the current levels',
      `SELECT i.id, i.available_qty, i.reserved_qty, l.available, l.reserved
         FROM commerce.inventory i
         JOIN (SELECT inventory_id,
                      sum(after_available_qty - before_available_qty)::int AS available,
                      sum(after_reserved_qty - before_reserved_qty)::int AS reserved
                 FROM commerce.inventory_transactions GROUP BY inventory_id) l ON l.inventory_id = i.id
        WHERE l.available <> i.available_qty OR l.reserved <> i.reserved_qty`,
    );
    await check(
      'available + reserved equals stock adjusted in minus stock shipped',
      `SELECT i.id, i.available_qty + i.reserved_qty AS on_hand, l.adjusted, l.shipped
         FROM commerce.inventory i
         JOIN (SELECT inventory_id,
                      coalesce(sum(after_available_qty - before_available_qty)
                               FILTER (WHERE txn_type = 'manual_adjustment'), 0)::int AS adjusted,
                      coalesce(sum(quantity) FILTER (WHERE txn_type = 'consume'), 0)::int AS shipped
                 FROM commerce.inventory_transactions GROUP BY inventory_id) l ON l.inventory_id = i.id
        WHERE i.available_qty + i.reserved_qty <> l.adjusted - l.shipped`,
    );
    await check(
      'every reservation matches its order status',
      `SELECT o.order_code, o.status, r.status AS reservation_status
         FROM commerce.orders o
         JOIN commerce.inventory_reservations r ON r.order_id = o.id
        WHERE r.status <> CASE o.status
                WHEN 'reserved' THEN 'held' WHEN 'paid' THEN 'held'
                WHEN 'fulfilled' THEN 'consumed' ELSE 'released' END`,
    );
    await check(
      'every order line has exactly one reservation',
      `SELECT oi.id FROM commerce.order_items oi
         LEFT JOIN commerce.inventory_reservations r ON r.order_item_id = oi.id
        WHERE r.id IS NULL`,
    );
    return violations;
  });
}
