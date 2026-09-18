import { z } from 'zod';
import { pagingQuerySchema, uuidSchema } from './common';

// StockFlow /orders. Money crosses the API as decimal strings (ADR 0010); quantities are
// whole units, so they stay JSON numbers.

/** Every status the database accepts. v1 only ever produces five of them. */
export const orderStatusSchema = z.enum([
  'pending',
  'reserved',
  'awaiting_payment',
  'paid',
  'fulfilled',
  'completed',
  'cancelled',
  'expired',
]);
export type OrderStatusValue = z.infer<typeof orderStatusSchema>;

/**
 * There is deliberately no price field: what a buyer pays comes only from the price
 * resolver. Unknown keys — `unit_price` included — are stripped by the schema.
 */
export const createOrderRequestSchema = z.object({
  warehouse_id: uuidSchema,
  items: z
    .array(z.object({ product_id: uuidSchema, quantity: z.number().int().min(1).max(1_000_000) }))
    .min(1)
    .max(200)
    .refine((items) => new Set(items.map((i) => i.product_id)).size === items.length, {
      message: 'each product may appear only once',
    }),
});
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

/** `Idempotency-Key` header: visible ASCII, the length a UUID or ULID needs and some room. */
export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,200}$/, 'must be 1-200 visible ASCII characters');

export const listOrdersQuerySchema = pagingQuerySchema.extend({
  status: orderStatusSchema.optional(),
  order_code: z.string().trim().toUpperCase().min(1).max(50).optional(),
  warehouse_id: uuidSchema.optional(),
  /** Ops only narrows by customer; a buyer only ever sees their own organisation. */
  buyer_org_id: uuidSchema.optional(),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export interface OrderItemView {
  id: string;
  product_id: string;
  sku: string;
  quantity: number;
  unit_price: string;
  line_total: string;
  /** The price-list tier that priced this line; null when the base price applied. */
  price_list_item_id: string | null;
}

export interface OrderView {
  id: string;
  order_code: string;
  buyer_org_id: string;
  placed_by_user_id: string;
  warehouse_id: string;
  status: OrderStatusValue;
  subtotal: string;
  total: string;
  currency: string;
  reservation_expires_at: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  expired_at: string | null;
  fulfilled_at: string | null;
  created_at: string;
  updated_at: string;
  items: OrderItemView[];
}
