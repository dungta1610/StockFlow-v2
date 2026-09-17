export const TXN_TYPES = ['manual_adjustment', 'reserve', 'release', 'consume'] as const;
export type TxnType = (typeof TXN_TYPES)[number];

/**
 * One row of the ledger. Append-only: the levels before and after are recorded when
 * the move happens and are never recomputed or corrected afterwards. A mistake is
 * fixed by another movement, the way a real stock book works.
 */
export interface InventoryTransaction {
  id: string;
  inventoryId: string;
  productId: string;
  warehouseId: string;
  /** Set from phase 04 on, when a movement belongs to an order. */
  orderId: string | null;
  reservationId: string | null;
  txnType: TxnType;
  /** Always positive: the direction is in the before/after levels. */
  quantity: number;
  beforeAvailableQty: number;
  afterAvailableQty: number;
  beforeReservedQty: number;
  afterReservedQty: number;
  reason: string;
  createdBy: string | null;
  createdAt: Date;
}

export interface LedgerFilter {
  inventoryId?: string;
  productId?: string;
  warehouseId?: string;
  orderId?: string;
  reservationId?: string;
  txnType?: TxnType;
}
