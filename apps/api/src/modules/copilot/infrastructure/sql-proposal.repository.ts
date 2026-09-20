import { Injectable } from '@nestjs/common';
import { type Paging, pagingSql, paramBinder } from '../../../platform/database/sql';
import type { Tx } from '../../../platform/database/tx';
import {
  type NewProposal,
  type ProposalDecision,
  ProposalRepository,
} from '../application/ports/proposal.repository';
import type {
  ProposalFilter,
  ProposalStatus,
  StockAdjustmentProposal,
} from '../domain/stock-adjustment-proposal';

interface ProposalRow {
  id: string;
  product_id: string;
  sku: string;
  product_name: string;
  warehouse_id: string;
  warehouse_code: string;
  delta_qty: number;
  reason: string;
  rationale: string | null;
  session_id: string | null;
  status: ProposalStatus;
  proposed_by_user_id: string;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  applied_transaction_id: string | null;
  created_at: Date;
}

/**
 * Proposals are always read with the SKU and warehouse code joined in: a list of
 * uuids is unreviewable, and the point of the queue is that a person can look at it
 * and decide.
 */
const SELECT = `
  SELECT p.id, p.product_id, pr.sku, pr.name AS product_name,
         p.warehouse_id, w.code AS warehouse_code,
         p.delta_qty, p.reason, p.rationale, p.session_id, p.status,
         p.proposed_by_user_id, p.decided_by_user_id, p.decided_at,
         p.applied_transaction_id, p.created_at
    FROM stock_adjustment_proposals p
    JOIN products pr ON pr.id = p.product_id
    JOIN warehouses w ON w.id = p.warehouse_id`;

const toProposal = (r: ProposalRow): StockAdjustmentProposal => ({
  id: r.id,
  productId: r.product_id,
  sku: r.sku,
  productName: r.product_name,
  warehouseId: r.warehouse_id,
  warehouseCode: r.warehouse_code,
  deltaQty: r.delta_qty,
  reason: r.reason,
  rationale: r.rationale,
  sessionId: r.session_id,
  status: r.status,
  proposedByUserId: r.proposed_by_user_id,
  decidedByUserId: r.decided_by_user_id,
  decidedAt: r.decided_at,
  appliedTransactionId: r.applied_transaction_id,
  createdAt: r.created_at,
});

/** The one file in `modules/copilot` that speaks SQL (docs/adr/0023). */
@Injectable()
export class SqlProposalRepository extends ProposalRepository {
  async create(tx: Tx, data: NewProposal): Promise<StockAdjustmentProposal> {
    const [inserted] = await tx.query<{ id: string }>(
      `INSERT INTO stock_adjustment_proposals
         (product_id, warehouse_id, delta_qty, reason, rationale, session_id, proposed_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        data.productId,
        data.warehouseId,
        data.deltaQty,
        data.reason,
        data.rationale,
        data.sessionId,
        data.proposedByUserId,
      ],
    );
    return (await this.findById(tx, inserted!.id))!;
  }

  async list(tx: Tx, filter: ProposalFilter, paging: Paging): Promise<StockAdjustmentProposal[]> {
    const params: unknown[] = [];
    const bind = paramBinder(params);
    const where = filter.status ? `WHERE p.status = ${bind(filter.status)}` : '';
    const rows = await tx.query<ProposalRow>(
      `${SELECT} ${where} ORDER BY p.created_at DESC, p.id DESC ${pagingSql(paging, params)}`,
      params,
    );
    return rows.map(toProposal);
  }

  async findById(tx: Tx, id: string): Promise<StockAdjustmentProposal | null> {
    const [row] = await tx.query<ProposalRow>(`${SELECT} WHERE p.id = $1`, [id]);
    return row ? toProposal(row) : null;
  }

  /**
   * Locks the proposal row, not the joined catalog rows: `FOR UPDATE OF p` keeps a
   * decision from blocking on a product or warehouse nobody is changing. Two
   * approvals of one proposal serialise here, and the second finds it decided.
   */
  async findByIdForUpdate(tx: Tx, id: string): Promise<StockAdjustmentProposal | null> {
    const [row] = await tx.query<ProposalRow>(`${SELECT} WHERE p.id = $1 FOR UPDATE OF p`, [id]);
    return row ? toProposal(row) : null;
  }

  async decide(tx: Tx, decision: ProposalDecision): Promise<void> {
    // The status guard is repeated here even though the caller checked it under the
    // row lock: it costs nothing and makes the statement correct on its own.
    await tx.query(
      `UPDATE stock_adjustment_proposals
          SET status = $2,
              decided_by_user_id = $3,
              decided_at = now(),
              applied_transaction_id = $4,
              updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [decision.id, decision.status, decision.decidedByUserId, decision.appliedTransactionId],
    );
  }
}
