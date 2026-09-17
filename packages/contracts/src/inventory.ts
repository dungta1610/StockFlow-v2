import { z } from 'zod';
import { pagingQuerySchema, uuidSchema } from './common';

// StockFlow /inventories. Quantities are whole units, so they stay JSON numbers;
// only money is a string (ADR 0010).

export const txnTypeSchema = z.enum(['manual_adjustment', 'reserve', 'release', 'consume']);
export type TxnType = z.infer<typeof txnTypeSchema>;

const quantity = z.number().int().min(-1_000_000).max(1_000_000);

/** StockFlow's InventoryAdjust: a signed delta, never an absolute level. */
export const adjustStockRequestSchema = z.object({
  product_id: uuidSchema,
  warehouse_id: uuidSchema,
  quantity: quantity.refine((q) => q !== 0, { message: 'must not be zero' }),
  reason: z.string().trim().max(500).default(''),
});
export type AdjustStockRequest = z.infer<typeof adjustStockRequestSchema>;

export const listInventoryQuerySchema = pagingQuerySchema.extend({
  product_id: uuidSchema.optional(),
  warehouse_id: uuidSchema.optional(),
});
export type ListInventoryQuery = z.infer<typeof listInventoryQuerySchema>;

/** StockFlow's GET /inventories/detail: by id, or by product and warehouse. */
export const inventoryDetailQuerySchema = z
  .object({
    id: uuidSchema.optional(),
    product_id: uuidSchema.optional(),
    warehouse_id: uuidSchema.optional(),
  })
  .refine((q) => q.id !== undefined || (q.product_id !== undefined && q.warehouse_id !== undefined), {
    message: 'provide id, or both product_id and warehouse_id',
  });
export type InventoryDetailQuery = z.infer<typeof inventoryDetailQuerySchema>;

export const listInventoryTransactionsQuerySchema = pagingQuerySchema.extend({
  inventory_id: uuidSchema.optional(),
  product_id: uuidSchema.optional(),
  warehouse_id: uuidSchema.optional(),
  order_id: uuidSchema.optional(),
  reservation_id: uuidSchema.optional(),
  txn_type: txnTypeSchema.optional(),
});
export type ListInventoryTransactionsQuery = z.infer<typeof listInventoryTransactionsQuerySchema>;

export interface InventoryView {
  id: string;
  product_id: string;
  sku: string;
  warehouse_id: string;
  warehouse_code: string;
  available_qty: number;
  reserved_qty: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface InventoryTransactionView {
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
  created_at: string;
}
