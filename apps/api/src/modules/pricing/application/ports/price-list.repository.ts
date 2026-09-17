import type { Paging } from '../../../../platform/database/sql';
import type { Tx } from '../../../../platform/database/tx';
import type { OrgScope } from '../../../identity/domain/org-scope';
import type { Money } from '../../domain/money';
import type { PriceList, PriceListFilter, PriceListItem } from '../../domain/price-list';

export abstract class PriceListRepository {
  abstract create(
    tx: Tx,
    data: {
      orgId: string | null;
      name: string;
      validFrom: Date;
      validTo: Date | null;
      priority: number;
    },
  ): Promise<PriceList>;

  /**
   * Null when the list does not exist or belongs to an organisation outside `scope`.
   * Default lists (no owner) are in every scope. `forUpdate` locks the row so a
   * concurrent archive cannot interleave.
   */
  abstract findById(
    tx: Tx,
    scope: OrgScope,
    id: string,
    opts?: { forUpdate?: boolean },
  ): Promise<PriceList | null>;

  /** Tiers ordered by SKU, then min_qty. */
  abstract findItems(tx: Tx, priceListId: string): Promise<PriceListItem[]>;

  abstract list(tx: Tx, scope: OrgScope, filter: PriceListFilter, paging: Paging): Promise<PriceList[]>;

  /** Inserts tiers, replacing the price of any (product, min_qty) that already exists. */
  abstract upsertItems(
    tx: Tx,
    priceListId: string,
    items: readonly { productId: string; minQty: number; unitPrice: Money }[],
  ): Promise<void>;

  /** Null when the list does not exist or is outside `scope`. Archiving twice is harmless. */
  abstract archive(tx: Tx, scope: OrgScope, id: string): Promise<PriceList | null>;
}
