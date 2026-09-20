import type { Paging } from '../../../../platform/database/sql';
import type { Tx } from '../../../../platform/database/tx';
import type { ProposalFilter, StockAdjustmentProposal } from '../../domain/stock-adjustment-proposal';

export interface NewProposal {
  productId: string;
  warehouseId: string;
  deltaQty: number;
  reason: string;
  rationale: string | null;
  sessionId: string | null;
  proposedByUserId: string;
}

export interface ProposalDecision {
  id: string;
  status: 'approved' | 'rejected';
  decidedByUserId: string;
  appliedTransactionId: string | null;
}

/** The only place the copilot module touches the database (docs/adr/0023). */
export abstract class ProposalRepository {
  abstract create(tx: Tx, data: NewProposal): Promise<StockAdjustmentProposal>;

  abstract list(tx: Tx, filter: ProposalFilter, paging: Paging): Promise<StockAdjustmentProposal[]>;

  abstract findById(tx: Tx, id: string): Promise<StockAdjustmentProposal | null>;

  /**
   * The row locked for update, so a decision reads and writes the same state.
   * Two approvals of one proposal serialise here rather than both applying.
   */
  abstract findByIdForUpdate(tx: Tx, id: string): Promise<StockAdjustmentProposal | null>;

  abstract decide(tx: Tx, decision: ProposalDecision): Promise<void>;
}
