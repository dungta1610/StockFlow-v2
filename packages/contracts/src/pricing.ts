import { z } from 'zod';
import { moneySchema, pagingQuerySchema, uuidSchema } from './common';

// Price lists (default and per customer) with quantity tiers, and quotes.

const isoDateTime = z.iso.datetime({ offset: true });

export const createPriceListRequestSchema = z.object({
  /** The buyer organisation this contract list is for; omit or null for the default list. */
  org_id: uuidSchema.nullable().default(null),
  name: z.string().trim().min(1).max(200),
  valid_from: isoDateTime,
  valid_to: isoDateTime.nullable().default(null),
  /** Higher wins among lists of the same kind. */
  priority: z.number().int().min(-1000).max(1000).default(0),
});
export type CreatePriceListRequest = z.infer<typeof createPriceListRequestSchema>;

/** Adds tiers or replaces the price of existing ones (keyed by product and min_qty). */
export const upsertPriceListItemsRequestSchema = z.object({
  items: z
    .array(
      z.object({
        product_id: uuidSchema,
        min_qty: z.number().int().min(1).default(1),
        unit_price: moneySchema,
      }),
    )
    .min(1)
    .max(500)
    .refine(
      (items) => new Set(items.map((i) => `${i.product_id}:${i.min_qty}`)).size === items.length,
      { message: 'each (product_id, min_qty) tier may appear only once' },
    ),
});
export type UpsertPriceListItemsRequest = z.infer<typeof upsertPriceListItemsRequestSchema>;

export const priceListStatusSchema = z.enum(['active', 'archived']);
export type PriceListStatusValue = z.infer<typeof priceListStatusSchema>;

export const listPriceListsQuerySchema = pagingQuerySchema.extend({
  org_id: uuidSchema.optional(),
  status: priceListStatusSchema.optional(),
});
export type ListPriceListsQuery = z.infer<typeof listPriceListsQuerySchema>;

export interface PriceListItemView {
  id: string;
  product_id: string;
  sku: string;
  min_qty: number;
  unit_price: string;
}

export interface PriceListView {
  id: string;
  org_id: string | null;
  name: string;
  currency: string;
  valid_from: string;
  valid_to: string | null;
  priority: number;
  status: PriceListStatusValue;
  created_at: string;
  updated_at: string;
  items?: PriceListItemView[];
}

// ── Quotes ───────────────────────────────────────────────────────────

export const quoteRequestSchema = z.object({
  /**
   * Ops staff quote for a named customer. Buyers always get their own prices; a
   * buyer passing another organisation is refused.
   */
  customer_org_id: uuidSchema.optional(),
  items: z
    .array(z.object({ product_id: uuidSchema, qty: z.number().int().min(1).max(1_000_000) }))
    .min(1)
    .max(200)
    .refine((items) => new Set(items.map((i) => i.product_id)).size === items.length, {
      message: 'each product may appear only once',
    }),
});
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export const priceSourceKindSchema = z.enum(['contract', 'default_list', 'base_price']);

export interface QuoteLineView {
  product_id: string;
  sku: string;
  qty: number;
  unit_price: string;
  line_total: string;
  source_kind: z.infer<typeof priceSourceKindSchema>;
  /** The price_list_items row used; null when the base price applied. */
  source_id: string | null;
  price_list_id: string | null;
  min_qty_applied: number;
}

export interface QuoteView {
  customer_org_id: string;
  currency: string;
  priced_at: string;
  lines: QuoteLineView[];
  total: string;
}
