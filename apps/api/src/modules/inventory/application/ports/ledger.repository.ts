import type { Paging } from '../../../../platform/database/sql';
import type { Tx } from '../../../../platform/database/tx';
import type { InventoryTransaction, LedgerFilter, TxnType } from '../../domain/inventory-transaction';

export interface LedgerEntry {
  inventoryId: string;
  productId: string;
  warehouseId: string;
  txnType: TxnType;
  /** Positive size of the move. */
  quantity: number;
  beforeAvailableQty: number;
  afterAvailableQty: number;
  beforeReservedQty: number;
  afterReservedQty: number;
  reason?: string;
  createdBy?: string | null;
  orderId?: string | null;
  reservationId?: string | null;
}

/**
 * Append-only by construction: this port offers no way to change or remove a row,
 * so no caller — not a job, not an agent tool — can rewrite stock history.
 */
export abstract class LedgerRepository {
  abstract append(tx: Tx, entry: LedgerEntry): Promise<InventoryTransaction>;

  abstract list(tx: Tx, filter: LedgerFilter, paging: Paging): Promise<InventoryTransaction[]>;
}
