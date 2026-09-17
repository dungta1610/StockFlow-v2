import { PricingErrors } from './errors';
import type { Money } from './money';

/** One price-list row that could price a product (see SqlPriceResolver). */
export interface PriceCandidate {
  itemId: string;
  listId: string;
  /** The customer the list belongs to; null for the default list. */
  listOrgId: string | null;
  priority: number;
  validFrom: Date;
  validTo: Date | null;
  status: 'active' | 'archived';
  minQty: number;
  unitPrice: Money;
}

export type PriceSourceKind = 'contract' | 'default_list' | 'base_price';

export interface ResolvedPrice {
  unitPrice: Money;
  sourceKind: PriceSourceKind;
  /** The price_list_items row used; null when the base price applied. */
  sourceId: string | null;
  priceListId: string | null;
  /** The tier the price comes from, so a UI or agent can explain it. */
  minQtyApplied: number;
}

/**
 * Chooses the unit price for one product. Pure, so the whole pricing policy is
 * tested without a database:
 *
 * 1. Keep rows that are active, valid at `at` (`valid_to` exclusive), belong to the
 *    customer or to the default list, and whose tier starts at or below `qty`.
 * 2. Pick one list: the customer's contract before the default list, then higher
 *    priority, then newer `valid_from`, then lowest list id — a total order, so the
 *    result never depends on row order.
 * 3. Within that list, take the largest tier not above `qty`. Tiers are never mixed
 *    across lists.
 * 4. With no usable row, fall back to the product's base price.
 */
export function pickPrice(
  candidates: readonly PriceCandidate[],
  customerOrgId: string,
  qty: number,
  at: Date,
  basePrice: Money,
): ResolvedPrice {
  if (!Number.isSafeInteger(qty) || qty < 1) throw PricingErrors.invalidQuantity();

  const usable = candidates.filter(
    (c) =>
      c.status === 'active' &&
      c.validFrom.getTime() <= at.getTime() &&
      (c.validTo === null || c.validTo.getTime() > at.getTime()) &&
      (c.listOrgId === customerOrgId || c.listOrgId === null) &&
      c.minQty <= qty,
  );
  if (usable.length === 0) {
    return { unitPrice: basePrice, sourceKind: 'base_price', sourceId: null, priceListId: null, minQtyApplied: 1 };
  }

  const best = [...usable].sort(byListPreference)[0]!;
  const tier = usable
    .filter((c) => c.listId === best.listId)
    .reduce((a, b) => (b.minQty > a.minQty ? b : a));

  return {
    unitPrice: tier.unitPrice,
    sourceKind: tier.listOrgId === null ? 'default_list' : 'contract',
    sourceId: tier.itemId,
    priceListId: tier.listId,
    minQtyApplied: tier.minQty,
  };
}

function byListPreference(a: PriceCandidate, b: PriceCandidate): number {
  const contract = Number(b.listOrgId !== null) - Number(a.listOrgId !== null);
  if (contract !== 0) return contract;
  if (a.priority !== b.priority) return b.priority - a.priority;
  const from = b.validFrom.getTime() - a.validFrom.getTime();
  if (from !== 0) return from;
  return a.listId < b.listId ? -1 : a.listId > b.listId ? 1 : 0;
}
