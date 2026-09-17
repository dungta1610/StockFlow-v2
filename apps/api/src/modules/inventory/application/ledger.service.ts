import { Injectable } from '@nestjs/common';
import type { Paging } from '../../../platform/database/sql';
import type { Tx } from '../../../platform/database/tx';
import { CatalogService } from '../../catalog/application/catalog.service';
import { CatalogErrors } from '../../catalog/domain/errors';
import { type Actor, assertRole } from '../../identity/domain/actor';
import type { InventoryTransaction, TxnType } from '../domain/inventory-transaction';
import { LedgerRepository } from './ports/ledger.repository';

/** Stock history by code, for the ops console and the copilot. Newest first. */
@Injectable()
export class LedgerService {
  constructor(
    private readonly ledger: LedgerRepository,
    private readonly catalog: CatalogService,
  ) {}

  async history(
    db: Tx,
    actor: Actor,
    query: { sku: string; warehouseCode?: string; txnType?: TxnType },
    paging: Paging,
  ): Promise<InventoryTransaction[]> {
    assertRole(actor, 'ops', 'ops_admin');
    const product = await this.catalog.findProductBySku(db, query.sku);
    if (!product) throw CatalogErrors.productNotFound();

    let warehouseId: string | undefined;
    if (query.warehouseCode !== undefined) {
      const warehouse = await this.catalog.findWarehouseByCode(db, query.warehouseCode);
      if (!warehouse) throw CatalogErrors.warehouseNotFound();
      warehouseId = warehouse.id;
    }

    return this.ledger.list(db, { productId: product.id, warehouseId, txnType: query.txnType }, paging);
  }
}
