import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../platform/database/tx';
import type { OrgScope } from '../../identity/domain/org-scope';
import { scopeSql } from '../../identity/infrastructure/scope-sql';
import {
  type ExpiringReservation,
  type NewReservation,
  ReservationRepository,
} from '../application/ports/reservation.repository';
import type { Reservation, ReservationStatus } from '../domain/order';

interface ReservationRow {
  id: string;
  order_id: string;
  order_item_id: string;
  inventory_id: string;
  product_id: string;
  warehouse_id: string;
  quantity: number;
  status: ReservationStatus;
  expires_at: Date | null;
  reserved_at: Date;
  released_at: Date | null;
  consumed_at: Date | null;
}

const COLUMNS = `r.id, r.order_id, r.order_item_id, r.inventory_id, r.product_id, r.warehouse_id,
  r.quantity, r.status, r.expires_at, r.reserved_at, r.released_at, r.consumed_at`;

const toReservation = (r: ReservationRow): Reservation => ({
  id: r.id,
  orderId: r.order_id,
  orderItemId: r.order_item_id,
  inventoryId: r.inventory_id,
  productId: r.product_id,
  warehouseId: r.warehouse_id,
  quantity: r.quantity,
  status: r.status,
  expiresAt: r.expires_at,
  reservedAt: r.reserved_at,
  releasedAt: r.released_at,
  consumedAt: r.consumed_at,
});

@Injectable()
export class SqlReservationRepository extends ReservationRepository {
  async insertMany(tx: Tx, rows: readonly NewReservation[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.query(
      `INSERT INTO inventory_reservations
         (id, order_id, order_item_id, inventory_id, product_id, warehouse_id, quantity, expires_at)
       SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[],
                            $7::int[], $8::timestamptz[])`,
      [
        rows.map((r) => r.id),
        rows.map((r) => r.orderId),
        rows.map((r) => r.orderItemId),
        rows.map((r) => r.inventoryId),
        rows.map((r) => r.productId),
        rows.map((r) => r.warehouseId),
        rows.map((r) => r.quantity),
        rows.map((r) => r.expiresAt),
      ],
    );
  }

  async lockHeld(tx: Tx, orderId: string): Promise<Reservation[]> {
    const rows = await tx.query<ReservationRow>(
      `SELECT ${COLUMNS} FROM inventory_reservations r
        WHERE r.order_id = $1 AND r.status = 'held'
        ORDER BY r.product_id, r.id
          FOR UPDATE`,
      [orderId],
    );
    return rows.map(toReservation);
  }

  async settle(tx: Tx, ids: readonly string[], status: 'released' | 'consumed'): Promise<void> {
    if (ids.length === 0) return;
    const stamp = status === 'released' ? 'released_at' : 'consumed_at';
    await tx.query(
      `UPDATE inventory_reservations
          SET status = $2, ${stamp} = now(), updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'held'`,
      [ids, status],
    );
  }

  async listByOrder(tx: Tx, orderId: string): Promise<Reservation[]> {
    const rows = await tx.query<ReservationRow>(
      `SELECT ${COLUMNS} FROM inventory_reservations r WHERE r.order_id = $1 ORDER BY r.product_id, r.id`,
      [orderId],
    );
    return rows.map(toReservation);
  }

  async listExpiring(tx: Tx, scope: OrgScope, until: Date, limit: number): Promise<ExpiringReservation[]> {
    const params: unknown[] = [until, limit];
    const rows = await tx.query<ReservationRow & { order_code: string; buyer_org_id: string; sku: string }>(
      `SELECT ${COLUMNS}, o.order_code, o.buyer_org_id, p.sku
         FROM inventory_reservations r
         JOIN orders o ON o.id = r.order_id
         JOIN products p ON p.id = r.product_id
        WHERE r.status = 'held' AND o.status = 'reserved' AND r.expires_at < $1
          AND ${scopeSql(scope, { id: 'o.buyer_org_id', type: 'o.buyer_org_type' }, params)}
        ORDER BY r.expires_at, r.id
        LIMIT $2`,
      params,
    );
    return rows.map((r) => ({ ...toReservation(r), orderCode: r.order_code, buyerOrgId: r.buyer_org_id, sku: r.sku }));
  }
}
