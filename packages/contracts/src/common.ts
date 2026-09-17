import { z } from 'zod';

/** Unified error envelope returned by every failed API request. */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** Query-string integer: absent or blank means "not provided"; anything else must parse. */
const optionalQueryInt = z.preprocess(
  (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : Number(v)),
  z.number().int().optional(),
);

/**
 * Paging query, ported from StockFlow's `model.Paging` + `Normalize()`:
 * page defaults to 1, limit defaults to 10 and is capped at 100.
 * A non-numeric value is rejected (StockFlow returned 400 "invalid page").
 */
export const pagingQuerySchema = z.object({
  page: optionalQueryInt.transform((p) => (p === undefined || p <= 0 ? 1 : p)),
  limit: optionalQueryInt.transform((l) => (l === undefined || l <= 0 ? 10 : Math.min(l, 100))),
});
export type PagingQuery = z.infer<typeof pagingQuerySchema>;

/** Response paging block, same shape StockFlow returned: `{ page, limit }`. */
export interface PagingMeta {
  page: number;
  limit: number;
}
