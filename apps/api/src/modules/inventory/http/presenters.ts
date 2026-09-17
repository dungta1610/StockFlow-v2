import type { InventoryTransactionView, InventoryView } from '@stockflow/contracts';
import type { InventoryDetail } from '../domain/inventory';
import type { InventoryTransaction } from '../domain/inventory-transaction';

export const presentInventory = (i: InventoryDetail): InventoryView => ({
  id: i.id,
  product_id: i.productId,
  sku: i.sku,
  warehouse_id: i.warehouseId,
  warehouse_code: i.warehouseCode,
  available_qty: i.availableQty,
  reserved_qty: i.reservedQty,
  version: i.version,
  created_at: i.createdAt.toISOString(),
  updated_at: i.updatedAt.toISOString(),
});

export const presentTransaction = (t: InventoryTransaction): InventoryTransactionView => ({
  id: t.id,
  inventory_id: t.inventoryId,
  product_id: t.productId,
  warehouse_id: t.warehouseId,
  order_id: t.orderId,
  reservation_id: t.reservationId,
  txn_type: t.txnType,
  quantity: t.quantity,
  before_available_qty: t.beforeAvailableQty,
  after_available_qty: t.afterAvailableQty,
  before_reserved_qty: t.beforeReservedQty,
  after_reserved_qty: t.afterReservedQty,
  reason: t.reason,
  created_by: t.createdBy,
  created_at: t.createdAt.toISOString(),
});
