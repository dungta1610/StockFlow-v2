import type { Tx } from '../../../../platform/database/tx';
import type { OrgScope } from '../../../identity/domain/org-scope';
import type { OrgType } from '../../../identity/domain/role';
import type { Money } from '../../domain/money';
import type { ResolvedPrice } from '../../domain/pick-price';

export interface PriceLine {
  productId: string;
  qty: number;
}

export interface PricedLine extends ResolvedPrice {
  productId: string;
  sku: string;
  qty: number;
  lineTotal: Money;
}

/**
 * The one place prices come from. Quotes, carts and orders all call this, so a
 * price shown to a buyer and the price they are charged cannot drift apart.
 */
export abstract class PriceResolver {
  /**
   * Prices `lines` for `customer` as of `at`, returned in request order.
   * Fails with NOT_FOUND when the customer is outside `scope`, PRODUCT_NOT_FOUND /
   * PRODUCT_INACTIVE for unusable products and INVALID_QUANTITY for bad quantities.
   * Uses a fixed number of queries whatever the number of lines.
   */
  abstract resolve(
    db: Tx,
    scope: OrgScope,
    customer: { id: string; type: OrgType },
    lines: readonly PriceLine[],
    at: Date,
  ): Promise<PricedLine[]>;
}
