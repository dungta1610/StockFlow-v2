import { Injectable } from '@nestjs/common';
import { type Paging, pagingSql, paramBinder } from '../../../platform/database/sql';
import type { Tx } from '../../../platform/database/tx';
import { InventoryRepository } from '../application/ports/inventory.repository';
import { InventoryErrors } from '../domain/errors';
import type { InventoryDetail, InventoryFilter, StockMove } from '../domain/inventory';

interface MoveRow {
  id: string;
  product_id: string;
  warehouse_id: string;
  available_qty: number;
  reserved_qty: number;
  before_available: number;
  before_reserved: number;
}

interface DetailRow {
  id: string;
  product_id: string;
  warehouse_id: string;
  available_qty: number;
  reserved_qty: number;
  version: number;
  created_at: Date;
  updated_at: Date;
  sku: string;
  warehouse_code: string;
  warehouse_name: string;
}

const DETAIL_SELECT = `
  SELECT i.id, i.product_id, i.warehouse_id, i.available_qty, i.reserved_qty, i.version,
         i.created_at, i.updated_at, p.sku, w.code AS warehouse_code, w.name AS warehouse_name
    FROM inventory i
    JOIN products p ON p.id = i.product_id
    JOIN warehouses w ON w.id = i.warehouse_id`;

const toDetail = (r: DetailRow): InventoryDetail => ({
  id: r.id,
  productId: r.product_id,
  warehouseId: r.warehouse_id,
  availableQty: r.available_qty,
  reservedQty: r.reserved_qty,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  sku: r.sku,
  warehouseCode: r.warehouse_code,
  warehouseName: r.warehouse_name,
});

/**
 * A non-positive quantity is a programming error, not a business outcome: zero would
 * "succeed" while moving nothing, and a negative one would invent stock. It must not
 * reach SQL, where a CHECK violation would poison the caller's whole transaction.
 */
function assertPositive(qty: number): void {
  if (!Number.isSafeInteger(qty) || qty < 1) throw InventoryErrors.invalidQuantity();
}

const toMove = (r: MoveRow | undefined): StockMove | null =>
  r
    ? {
        inventoryId: r.id,
        productId: r.product_id,
        warehouseId: r.warehouse_id,
        before: { available: r.before_available, reserved: r.before_reserved },
        after: { available: r.available_qty, reserved: r.reserved_qty },
      }
    : null;

@Injectable()
export class SqlInventoryRepository extends InventoryRepository {
  /**
   * Two statements, both safe to race: for an increase, an idempotent insert that
   * makes sure the row exists, then the conditional update that moves the stock.
   * StockFlow instead read the row `FOR UPDATE` and inserted when it found nothing —
   * but `FOR UPDATE` locks nothing when there is no row, so two first-ever
   * adjustments for the same pair collided.
   *
   * A decrease never inserts: on a pair that has no row the update simply matches
   * nothing, which is what keeps the null contract honest — a null adjustment must
   * leave no trace, not a row at zero that no ledger entry explains.
   *
   * A brand-new row starts at version 0, so the adjustment that follows leaves it at
   * version 1 — one movement, one version.
   */
  async adjustAtomic(tx: Tx, productId: string, warehouseId: string, delta: number): Promise<StockMove | null> {
    if (!Number.isSafeInteger(delta) || delta === 0) throw InventoryErrors.invalidAdjustment();
    if (delta > 0) {
      await tx.query(
        `INSERT INTO inventory (product_id, warehouse_id, available_qty, reserved_qty, version)
         VALUES ($1, $2, 0, 0, 0)
         ON CONFLICT (product_id, warehouse_id) DO NOTHING`,
        [productId, warehouseId],
      );
    }
    const [row] = await tx.query<MoveRow>(
      `UPDATE inventory
          SET available_qty = available_qty + $3, version = version + 1, updated_at = now()
        WHERE product_id = $1 AND warehouse_id = $2 AND available_qty + $3 >= 0
       RETURNING id, product_id, warehouse_id, available_qty, reserved_qty,
                 available_qty - $3 AS before_available, reserved_qty AS before_reserved`,
      [productId, warehouseId, delta],
    );
    return toMove(row);
  }

  async reserveAtomic(tx: Tx, productId: string, warehouseId: string, qty: number): Promise<StockMove | null> {
    assertPositive(qty);
    const [row] = await tx.query<MoveRow>(
      `UPDATE inventory
          SET available_qty = available_qty - $3, reserved_qty = reserved_qty + $3,
              version = version + 1, updated_at = now()
        WHERE product_id = $1 AND warehouse_id = $2 AND available_qty >= $3
       RETURNING id, product_id, warehouse_id, available_qty, reserved_qty,
                 available_qty + $3 AS before_available, reserved_qty - $3 AS before_reserved`,
      [productId, warehouseId, qty],
    );
    return toMove(row);
  }

  async releaseAtomic(tx: Tx, inventoryId: string, qty: number): Promise<StockMove | null> {
    assertPositive(qty);
    const [row] = await tx.query<MoveRow>(
      `UPDATE inventory
          SET available_qty = available_qty + $2, reserved_qty = reserved_qty - $2,
              version = version + 1, updated_at = now()
        WHERE id = $1 AND reserved_qty >= $2
       RETURNING id, product_id, warehouse_id, available_qty, reserved_qty,
                 available_qty - $2 AS before_available, reserved_qty + $2 AS before_reserved`,
      [inventoryId, qty],
    );
    return toMove(row);
  }

  async consumeAtomic(tx: Tx, inventoryId: string, qty: number): Promise<StockMove | null> {
    assertPositive(qty);
    const [row] = await tx.query<MoveRow>(
      `UPDATE inventory
          SET reserved_qty = reserved_qty - $2, version = version + 1, updated_at = now()
        WHERE id = $1 AND reserved_qty >= $2
       RETURNING id, product_id, warehouse_id, available_qty, reserved_qty,
                 available_qty AS before_available, reserved_qty + $2 AS before_reserved`,
      [inventoryId, qty],
    );
    return toMove(row);
  }

  async findById(tx: Tx, id: string): Promise<InventoryDetail | null> {
    const [row] = await tx.query<DetailRow>(`${DETAIL_SELECT} WHERE i.id = $1`, [id]);
    return row ? toDetail(row) : null;
  }

  async findByProductAndWarehouse(
    tx: Tx,
    productId: string,
    warehouseId: string,
  ): Promise<InventoryDetail | null> {
    const [row] = await tx.query<DetailRow>(
      `${DETAIL_SELECT} WHERE i.product_id = $1 AND i.warehouse_id = $2`,
      [productId, warehouseId],
    );
    return row ? toDetail(row) : null;
  }

  async findByProduct(tx: Tx, productId: string, warehouseId?: string): Promise<InventoryDetail[]> {
    const params: unknown[] = [productId];
    let where = 'i.product_id = $1';
    if (warehouseId !== undefined) {
      params.push(warehouseId);
      where += ' AND i.warehouse_id = $2';
    }
    const rows = await tx.query<DetailRow>(`${DETAIL_SELECT} WHERE ${where} ORDER BY w.code`, params);
    return rows.map(toDetail);
  }

  async list(tx: Tx, filter: InventoryFilter, paging: Paging): Promise<InventoryDetail[]> {
    const params: unknown[] = [];
    const bind = paramBinder(params);
    const where = ['TRUE'];
    if (filter.productId) where.push(`i.product_id = ${bind(filter.productId)}`);
    if (filter.warehouseId) where.push(`i.warehouse_id = ${bind(filter.warehouseId)}`);
    const rows = await tx.query<DetailRow>(
      `${DETAIL_SELECT}
        WHERE ${where.join(' AND ')}
        ORDER BY p.sku, w.code
        ${pagingSql(paging, params)}`,
      params,
    );
    return rows.map(toDetail);
  }
}
