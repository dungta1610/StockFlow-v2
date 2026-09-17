// Stock, ported from StockFlow module/inventory. Quantities are whole units.

export interface Inventory {
  id: string;
  productId: string;
  warehouseId: string;
  availableQty: number;
  reservedQty: number;
  /** Audit only; v1 does not use it as an optimistic lock (ADR 0012). */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A stock row together with the codes people actually read. */
export interface InventoryDetail extends Inventory {
  sku: string;
  warehouseCode: string;
  warehouseName: string;
}

/** What a stock row holds at one moment. */
export interface StockLevel {
  available: number;
  reserved: number;
}

/**
 * The outcome of one atomic stock move. `before` and `after` come back from the
 * same statement that made the change, so the ledger cannot describe a state that
 * never existed.
 */
export interface StockMove {
  inventoryId: string;
  productId: string;
  warehouseId: string;
  before: StockLevel;
  after: StockLevel;
}

export interface InventoryFilter {
  productId?: string;
  warehouseId?: string;
}
