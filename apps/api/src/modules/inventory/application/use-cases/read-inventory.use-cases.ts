import { Injectable } from '@nestjs/common';
import type { Paging } from '../../../../platform/database/sql';
import type { Tx } from '../../../../platform/database/tx';
import { type Actor, assertRole } from '../../../identity/domain/actor';
import type { InventoryDetail, InventoryFilter } from '../../domain/inventory';
import type { InventoryTransaction, LedgerFilter } from '../../domain/inventory-transaction';
import { InventoryErrors } from '../../domain/errors';
import { InventoryRepository } from '../ports/inventory.repository';
import { LedgerRepository } from '../ports/ledger.repository';

// Stock levels and their history are supplier data: only ops staff read them.
// Buyers learn what they can order through the catalog and their quotes.

@Injectable()
export class GetInventoryUseCase {
  constructor(private readonly inventory: InventoryRepository) {}

  /** StockFlow's GET /inventories/detail: by id, or by product and warehouse. */
  async execute(
    db: Tx,
    actor: Actor,
    query: { id?: string; productId?: string; warehouseId?: string },
  ): Promise<InventoryDetail> {
    assertRole(actor, 'ops', 'ops_admin');
    const found = query.id
      ? await this.inventory.findById(db, query.id)
      : query.productId && query.warehouseId
        ? await this.inventory.findByProductAndWarehouse(db, query.productId, query.warehouseId)
        : null;
    if (!found) throw InventoryErrors.inventoryNotFound();
    return found;
  }
}

@Injectable()
export class ListInventoryUseCase {
  constructor(private readonly inventory: InventoryRepository) {}

  async execute(db: Tx, actor: Actor, filter: InventoryFilter, paging: Paging): Promise<InventoryDetail[]> {
    assertRole(actor, 'ops', 'ops_admin');
    return this.inventory.list(db, filter, paging);
  }
}

@Injectable()
export class ListInventoryTransactionsUseCase {
  constructor(private readonly ledger: LedgerRepository) {}

  async execute(db: Tx, actor: Actor, filter: LedgerFilter, paging: Paging): Promise<InventoryTransaction[]> {
    assertRole(actor, 'ops', 'ops_admin');
    return this.ledger.list(db, filter, paging);
  }
}
