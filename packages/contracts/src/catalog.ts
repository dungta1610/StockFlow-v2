import { z } from 'zod';
import { moneySchema, pagingQuerySchema, queryBoolSchema } from './common';

// StockFlow /products and /warehouses. Codes are stored upper-case and trimmed, as
// StockFlow's Filter.Normalize() did.

const code = z.string().trim().toUpperCase().min(1).max(64);
const name = z.string().trim().min(1).max(200);

// ── Products ─────────────────────────────────────────────────────────

export const createProductRequestSchema = z.object({
  sku: code,
  name,
  description: z.string().trim().max(2000).default(''),
  /** List price. StockFlow called it `price` and sent a float. */
  base_price: moneySchema,
  uom: z.string().trim().min(1).max(20).default('each'),
});
export type CreateProductRequest = z.infer<typeof createProductRequestSchema>;

/** StockFlow's ProductUpdate. The SKU is immutable. */
export const updateProductRequestSchema = z.object({
  name,
  description: z.string().trim().max(2000).default(''),
  base_price: moneySchema,
  is_active: z.boolean().optional(),
});
export type UpdateProductRequest = z.infer<typeof updateProductRequestSchema>;

export const listProductsQuerySchema = pagingQuerySchema.extend({
  sku: z.string().trim().toUpperCase().optional(),
  name: z.string().trim().optional(),
  is_active: queryBoolSchema.optional(),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export interface ProductView {
  id: string;
  sku: string;
  name: string;
  description: string;
  base_price: string;
  currency: string;
  uom: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ── Warehouses ───────────────────────────────────────────────────────

export const createWarehouseRequestSchema = z.object({
  code,
  name,
  address: z.string().trim().max(500).default(''),
});
export type CreateWarehouseRequest = z.infer<typeof createWarehouseRequestSchema>;

/** StockFlow's WarehouseUpdate. The code is immutable. */
export const updateWarehouseRequestSchema = z.object({
  name,
  address: z.string().trim().max(500).default(''),
  is_active: z.boolean().optional(),
});
export type UpdateWarehouseRequest = z.infer<typeof updateWarehouseRequestSchema>;

export const listWarehousesQuerySchema = pagingQuerySchema.extend({
  code: z.string().trim().toUpperCase().optional(),
  name: z.string().trim().optional(),
  is_active: queryBoolSchema.optional(),
});
export type ListWarehousesQuery = z.infer<typeof listWarehousesQuerySchema>;

export interface WarehouseView {
  id: string;
  code: string;
  name: string;
  address: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
