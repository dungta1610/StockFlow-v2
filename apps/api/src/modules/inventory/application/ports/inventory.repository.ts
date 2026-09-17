import type { Paging } from '../../../../platform/database/sql';
import type { Tx } from '../../../../platform/database/tx';
import type { InventoryDetail, InventoryFilter, StockMove } from '../../domain/inventory';

/**
 * Every write is a single conditional statement that returns the levels before and
 * after. `null` always means the same thing: **the condition did not hold and
 * nothing changed** — no row was created, updated or locked. Ordering (phase 04)
 * relies on exactly that to decide whether to roll back.
 */
export abstract class InventoryRepository {
  /**
   * Adds `delta` (signed) to available stock, creating the row when the pair has
   * never been stocked. Null when the result would be negative.
   */
  abstract adjustAtomic(
    tx: Tx,
    productId: string,
    warehouseId: string,
    delta: number,
  ): Promise<StockMove | null>;

  /** available -= qty, reserved += qty. Null when available < qty or no row exists. */
  abstract reserveAtomic(
    tx: Tx,
    productId: string,
    warehouseId: string,
    qty: number,
  ): Promise<StockMove | null>;

  /** available += qty, reserved -= qty. Null when reserved < qty. */
  abstract releaseAtomic(tx: Tx, inventoryId: string, qty: number): Promise<StockMove | null>;

  /** reserved -= qty, available unchanged — the goods have left. Null when reserved < qty. */
  abstract consumeAtomic(tx: Tx, inventoryId: string, qty: number): Promise<StockMove | null>;

  abstract findById(tx: Tx, id: string): Promise<InventoryDetail | null>;

  abstract findByProductAndWarehouse(
    tx: Tx,
    productId: string,
    warehouseId: string,
  ): Promise<InventoryDetail | null>;

  abstract list(tx: Tx, filter: InventoryFilter, paging: Paging): Promise<InventoryDetail[]>;

  /** Every stock row for one product, ordered by warehouse code — no paging to hide behind. */
  abstract findByProduct(tx: Tx, productId: string, warehouseId?: string): Promise<InventoryDetail[]>;
}
