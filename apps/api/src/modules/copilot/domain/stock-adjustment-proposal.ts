export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * A stock change the copilot suggested and a person has to decide on.
 *
 * It is a record of an intention, never of a movement: nothing here has touched
 * `inventories`. Approving is what runs the ordinary adjustment, and
 * `appliedTransactionId` is the ledger row it produced — so a reviewer can follow
 * conversation → proposal → approver → ledger without leaving the table.
 */
export interface StockAdjustmentProposal {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  warehouseId: string;
  warehouseCode: string;
  /** Signed, never zero. */
  deltaQty: number;
  reason: string;
  /** The agent's own explanation, verbatim. */
  rationale: string | null;
  sessionId: string | null;
  status: ProposalStatus;
  proposedByUserId: string;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  appliedTransactionId: string | null;
  createdAt: Date;
}

export interface ProposalFilter {
  status?: ProposalStatus;
}
