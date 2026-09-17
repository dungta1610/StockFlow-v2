import { Injectable } from '@nestjs/common';
import { type Paging, pagingSql, paramBinder } from '../../../platform/database/sql';
import type { Tx } from '../../../platform/database/tx';
import { type LedgerEntry, LedgerRepository } from '../application/ports/ledger.repository';
import type { InventoryTransaction, LedgerFilter, TxnType } from '../domain/inventory-transaction';

interface TxnRow {
  id: string;
  inventory_id: string;
  product_id: string;
  warehouse_id: string;
  order_id: string | null;
  reservation_id: string | null;
  txn_type: TxnType;
  quantity: number;
  before_available_qty: number;
  after_available_qty: number;
  before_reserved_qty: number;
  after_reserved_qty: number;
  reason: string;
  created_by: string | null;
  created_at: Date;
}

const COLUMNS = `id, inventory_id, product_id, warehouse_id, order_id, reservation_id, txn_type,
                 quantity, before_available_qty, after_available_qty, before_reserved_qty,
                 after_reserved_qty, reason, created_by, created_at`;

const toTransaction = (r: TxnRow): InventoryTransaction => ({
  id: r.id,
  inventoryId: r.inventory_id,
  productId: r.product_id,
  warehouseId: r.warehouse_id,
  orderId: r.order_id,
  reservationId: r.reservation_id,
  txnType: r.txn_type,
  quantity: r.quantity,
  beforeAvailableQty: r.before_available_qty,
  afterAvailableQty: r.after_available_qty,
  beforeReservedQty: r.before_reserved_qty,
  afterReservedQty: r.after_reserved_qty,
  reason: r.reason,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/** Insert and read only: there is deliberately no way to change a row. */
@Injectable()
export class SqlLedgerRepository extends LedgerRepository {
  async append(tx: Tx, entry: LedgerEntry): Promise<InventoryTransaction> {
    const [row] = await tx.query<TxnRow>(
      `INSERT INTO inventory_transactions
         (inventory_id, product_id, warehouse_id, order_id, reservation_id, txn_type, quantity,
          before_available_qty, after_available_qty, before_reserved_qty, after_reserved_qty,
          reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${COLUMNS}`,
      [
        entry.inventoryId,
        entry.productId,
        entry.warehouseId,
        entry.orderId ?? null,
        entry.reservationId ?? null,
        entry.txnType,
        entry.quantity,
        entry.beforeAvailableQty,
        entry.afterAvailableQty,
        entry.beforeReservedQty,
        entry.afterReservedQty,
        entry.reason ?? '',
        entry.createdBy ?? null,
      ],
    );
    return toTransaction(row!);
  }

  async list(tx: Tx, filter: LedgerFilter, paging: Paging): Promise<InventoryTransaction[]> {
    const params: unknown[] = [];
    const bind = paramBinder(params);
    const where = ['TRUE'];
    if (filter.inventoryId) where.push(`inventory_id = ${bind(filter.inventoryId)}`);
    if (filter.productId) where.push(`product_id = ${bind(filter.productId)}`);
    if (filter.warehouseId) where.push(`warehouse_id = ${bind(filter.warehouseId)}`);
    if (filter.orderId) where.push(`order_id = ${bind(filter.orderId)}`);
    if (filter.reservationId) where.push(`reservation_id = ${bind(filter.reservationId)}`);
    if (filter.txnType) where.push(`txn_type = ${bind(filter.txnType)}`);
    const rows = await tx.query<TxnRow>(
      `SELECT ${COLUMNS} FROM inventory_transactions
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        ${pagingSql(paging, params)}`,
      params,
    );
    return rows.map(toTransaction);
  }
}
