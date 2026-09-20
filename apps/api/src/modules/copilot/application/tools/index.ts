import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ToolRegistry } from '@stockflow/ai-harness';
import { CatalogService } from '../../../catalog/application/catalog.service';
import { OrganizationRepository } from '../../../identity/application/ports/organization.repository';
import { InventoryService } from '../../../inventory/application/inventory.service';
import { LedgerService } from '../../../inventory/application/ledger.service';
import { OrderService } from '../../../ordering/application/order.service';
import { ReservationService } from '../../../ordering/application/reservation.service';
import { QuotePricesUseCase } from '../../../pricing/application/use-cases/quote-prices.use-case';
import { OPS_COPILOT_TOOLS } from '../agent.registry';
import { ProposalService } from '../proposal.service';
import { makeExplainOrderBlockersTool } from './explain-order-blockers.tool';
import { makeFindOrdersTool } from './find-orders.tool';
import { makeGetContractPriceTool } from './get-contract-price.tool';
import { makeGetInventoryStatusTool } from './get-inventory-status.tool';
import { makeInventoryMovementHistoryTool } from './inventory-movement-history.tool';
import { makeListExpiringReservationsTool } from './list-expiring-reservations.tool';
import { makeProposeStockAdjustmentTool } from './propose-stock-adjustment.tool';
import { ToolDeps } from './tool-deps';

/**
 * Hands the copilot's tools to the harness at boot.
 *
 * Registration rather than `forRoot` configuration for the same reason outbox
 * handlers register themselves with the relay: these tools need injected
 * application services, and `forRoot` runs before any of them exist.
 *
 * Adding an eighth tool is one new file and one line below.
 */
@Injectable()
export class CopilotTools implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly deps: ToolDeps,
    private readonly inventory: InventoryService,
    private readonly ledger: LedgerService,
    private readonly orders: OrderService,
    private readonly reservations: ReservationService,
    private readonly quotes: QuotePricesUseCase,
    private readonly organizations: OrganizationRepository,
    private readonly catalog: CatalogService,
    private readonly proposals: ProposalService,
  ) {}

  onModuleInit(): void {
    for (const factory of [
      makeGetInventoryStatusTool(this.inventory, this.deps),
      makeFindOrdersTool(this.orders, this.deps),
      makeExplainOrderBlockersTool(this.orders, this.deps),
      makeListExpiringReservationsTool(this.reservations, this.deps),
      makeGetContractPriceTool(this.quotes, this.organizations, this.catalog, this.deps),
      makeInventoryMovementHistoryTool(this.ledger, this.deps),
      makeProposeStockAdjustmentTool(this.proposals, this.deps),
    ]) {
      this.registry.register(factory);
    }
    // A registry missing a tool the agent names is a wiring mistake, and boot is
    // the only cheap moment to notice it.
    this.registry.assertKnown(OPS_COPILOT_TOOLS);
  }
}
