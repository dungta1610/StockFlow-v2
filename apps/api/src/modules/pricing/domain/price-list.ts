import type { Money } from './money';

export type PriceListStatus = 'active' | 'archived';

/**
 * A default list (`orgId` null) or one buyer's contract list. Lists are archived,
 * never deleted: orders keep pointing at the tiers that priced them.
 */
export interface PriceList {
  id: string;
  orgId: string | null;
  name: string;
  currency: string;
  validFrom: Date;
  /** Exclusive; null means open-ended. */
  validTo: Date | null;
  priority: number;
  status: PriceListStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** One quantity tier: from `minQty` units upward the product costs `unitPrice`. */
export interface PriceListItem {
  id: string;
  productId: string;
  sku: string;
  minQty: number;
  unitPrice: Money;
}

export interface PriceListFilter {
  orgId?: string;
  status?: PriceListStatus;
}
