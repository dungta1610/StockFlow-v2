import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../../platform/database/tx';
import { type Actor, assertRole } from '../../../identity/domain/actor';
import { AdjustStockUseCase } from '../../../inventory/application/use-cases/adjust-stock.use-case';
import { CopilotErrors } from '../../domain/errors';
import type { StockAdjustmentProposal } from '../../domain/stock-adjustment-proposal';
import { ProposalRepository } from '../ports/proposal.repository';

/**
 * Approving a proposal.
 *
 * Three guarantees, each in the place that can actually hold it:
 *
 * - **Only an ops admin decides.** `assertRole` here, not only `@Roles` on the
 *   route — jobs and tools reach use cases without an HTTP request.
 * - **Nobody approves their own.** Checked here for a readable error, and again by
 *   `chk_no_self_decision` in the database, because this is the guarantee the whole
 *   human-in-the-loop design rests on.
 * - **Approving twice adds stock once.** The row is locked for update and its
 *   status re-read inside the same transaction as the adjustment, so a second
 *   approval either waits and then finds it decided, or fails to find it pending.
 *
 * The adjustment itself runs through the ordinary `AdjustStockUseCase` — same
 * transaction, same guards, same ledger row as a correction typed in by hand.
 * An agent-originated change is not a different kind of change.
 */
@Injectable()
export class ApproveProposalUseCase {
  constructor(
    private readonly proposals: ProposalRepository,
    private readonly adjust: AdjustStockUseCase,
  ) {}

  async execute(tx: Tx, actor: Actor, proposalId: string): Promise<StockAdjustmentProposal> {
    assertRole(actor, 'ops_admin');

    const proposal = await this.proposals.findByIdForUpdate(tx, proposalId);
    if (!proposal) throw CopilotErrors.proposalNotFound();
    if (proposal.status !== 'pending') throw CopilotErrors.proposalAlreadyDecided(proposal.status);
    if (proposal.proposedByUserId === actor.userId) throw CopilotErrors.cannotDecideOwnProposal();

    const detail = await this.adjust.execute(tx, actor, {
      productId: proposal.productId,
      warehouseId: proposal.warehouseId,
      quantity: proposal.deltaQty,
      reason: proposal.reason,
    });

    await this.proposals.decide(tx, {
      id: proposal.id,
      status: 'approved',
      decidedByUserId: actor.userId,
      appliedTransactionId: detail.transactionId,
    });

    return (await this.proposals.findById(tx, proposal.id))!;
  }
}

/** Rejecting changes no stock; it records that a person looked and said no. */
@Injectable()
export class RejectProposalUseCase {
  constructor(private readonly proposals: ProposalRepository) {}

  async execute(tx: Tx, actor: Actor, proposalId: string): Promise<StockAdjustmentProposal> {
    assertRole(actor, 'ops', 'ops_admin');

    const proposal = await this.proposals.findByIdForUpdate(tx, proposalId);
    if (!proposal) throw CopilotErrors.proposalNotFound();
    if (proposal.status !== 'pending') throw CopilotErrors.proposalAlreadyDecided(proposal.status);
    if (proposal.proposedByUserId === actor.userId) throw CopilotErrors.cannotDecideOwnProposal();

    await this.proposals.decide(tx, {
      id: proposal.id,
      status: 'rejected',
      decidedByUserId: actor.userId,
      appliedTransactionId: null,
    });
    return (await this.proposals.findById(tx, proposal.id))!;
  }
}
