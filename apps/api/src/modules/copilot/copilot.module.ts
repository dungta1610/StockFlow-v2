import { Module } from '@nestjs/common';
import { RateLimitModule } from '../../platform/ratelimit/ratelimit.module';
import { CatalogModule } from '../catalog/catalog.module';
import { IdentityModule } from '../identity/identity.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrderingModule } from '../ordering/ordering.module';
import { PricingModule } from '../pricing/pricing.module';
import { CopilotActorResolver } from './application/copilot-context';
import { ProposalRepository } from './application/ports/proposal.repository';
import { ProposalService } from './application/proposal.service';
import { CopilotTools } from './application/tools';
import { ToolDeps } from './application/tools/tool-deps';
import { CopilotSessionUseCases } from './application/use-cases/copilot-session.use-cases';
import {
  ApproveProposalUseCase,
  RejectProposalUseCase,
} from './application/use-cases/proposal.use-cases';
import { CopilotController } from './http/copilot.controller';
import { ProposalController } from './http/proposal.controller';
import { SqlProposalRepository } from './infrastructure/sql-proposal.repository';

/**
 * The ops copilot.
 *
 * Note which modules it imports: the ones whose *services* it calls. It adds no
 * data access of its own beyond `SqlProposalRepository`, and therefore no new way
 * into the database — the agent travels the road the HTTP controllers already
 * travel (docs/adr/0023).
 *
 * `AiHarnessModule` is global-ish by composition: it is imported once in
 * `AppModule` and exports what this module injects.
 */
@Module({
  imports: [IdentityModule, CatalogModule, PricingModule, InventoryModule, OrderingModule, RateLimitModule],
  controllers: [CopilotController, ProposalController],
  providers: [
    { provide: ProposalRepository, useClass: SqlProposalRepository },
    CopilotActorResolver,
    ToolDeps,
    ProposalService,
    ApproveProposalUseCase,
    RejectProposalUseCase,
    CopilotSessionUseCases,
    CopilotTools,
  ],
  exports: [ProposalService, CopilotSessionUseCases],
})
export class CopilotModule {}
