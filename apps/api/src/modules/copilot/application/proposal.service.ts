import { Injectable } from '@nestjs/common';
import type { Paging } from '../../../platform/database/sql';
import type { Tx } from '../../../platform/database/tx';
import { CatalogService } from '../../catalog/application/catalog.service';
import { CatalogErrors } from '../../catalog/domain/errors';
import { type Actor, assertRole } from '../../identity/domain/actor';
import { InventoryErrors } from '../../inventory/domain/errors';
import type { ProposalFilter, StockAdjustmentProposal } from '../domain/stock-adjustment-proposal';
import { ProposalRepository } from './ports/proposal.repository';

/**
 * Stock adjustments waiting for a person.
 *
 * Creating one changes no stock. That is the whole design: the agent does the part
 * it is good at — noticing a discrepancy and writing down why — and a second
 * person does the part that has consequences (docs/adr/0024).
 */
@Injectable()
export class ProposalService {
  constructor(
    private readonly proposals: ProposalRepository,
    private readonly catalog: CatalogService,
  ) {}

  async create(
    tx: Tx,
    actor: Actor,
    input: { sku: string; warehouseCode: string; deltaQty: number; reason: string; rationale?: string },
    sessionId: string | null,
  ): Promise<StockAdjustmentProposal> {
    assertRole(actor, 'ops', 'ops_admin');
    if (!Number.isSafeInteger(input.deltaQty) || input.deltaQty === 0) {
      throw InventoryErrors.invalidAdjustment();
    }

    const [product, warehouse] = await Promise.all([
      this.catalog.findProductBySku(tx, input.sku),
      this.catalog.findWarehouseByCode(tx, input.warehouseCode),
    ]);
    if (!product) throw CatalogErrors.productNotFound();
    if (!warehouse) throw CatalogErrors.warehouseNotFound();

    return this.proposals.create(tx, {
      productId: product.id,
      warehouseId: warehouse.id,
      deltaQty: input.deltaQty,
      reason: input.reason,
      rationale: input.rationale ?? null,
      sessionId,
      proposedByUserId: actor.userId,
    });
  }

  list(tx: Tx, actor: Actor, filter: ProposalFilter, paging: Paging): Promise<StockAdjustmentProposal[]> {
    assertRole(actor, 'ops', 'ops_admin');
    return this.proposals.list(tx, filter, paging);
  }
}
