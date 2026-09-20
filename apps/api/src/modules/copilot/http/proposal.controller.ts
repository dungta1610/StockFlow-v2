import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  type ListProposalsQuery,
  type RejectProposalRequest,
  listProposalsQuerySchema,
  rejectProposalRequestSchema,
} from '@stockflow/contracts';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, Roles } from '../../identity/http/auth.decorators';
import { ProposalService } from '../application/proposal.service';
import {
  ApproveProposalUseCase,
  RejectProposalUseCase,
} from '../application/use-cases/proposal.use-cases';
import { presentProposal } from './presenters';

/**
 * The review queue for stock adjustments the copilot proposed.
 *
 * Approving is `ops_admin` only, in two places: the decorator here and
 * `assertRole` inside the use case. The second is the one that counts — the first
 * only covers callers who arrived over HTTP.
 */
@Controller('ops/stock-adjustment-proposals')
@Roles('ops', 'ops_admin')
export class ProposalController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly proposals: ProposalService,
    private readonly approveUseCase: ApproveProposalUseCase,
    private readonly rejectUseCase: RejectProposalUseCase,
  ) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listProposalsQuerySchema)) q: ListProposalsQuery,
  ) {
    const paging = { page: q.page, limit: q.limit };
    const found = await this.proposals.list(this.uow.db, actor, { status: q.status }, paging);
    return { data: found.map(presentProposal), paging };
  }

  /** Applies the adjustment and records the decision in one transaction. */
  @Post(':proposalId/approve')
  // Deciding changes an existing proposal; it creates nothing.
  @HttpCode(200)
  @Roles('ops_admin')
  async approve(@CurrentActor() actor: Actor, @Param('proposalId', ParseUUIDPipe) proposalId: string) {
    const decided = await this.uow.withTransaction((tx) =>
      this.approveUseCase.execute(tx, actor, proposalId),
    );
    return { data: presentProposal(decided) };
  }

  @Post(':proposalId/reject')
  @HttpCode(200)
  async reject(
    @CurrentActor() actor: Actor,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body(new ZodValidationPipe(rejectProposalRequestSchema)) _body: RejectProposalRequest,
  ) {
    const decided = await this.uow.withTransaction((tx) =>
      this.rejectUseCase.execute(tx, actor, proposalId),
    );
    return { data: presentProposal(decided) };
  }
}
