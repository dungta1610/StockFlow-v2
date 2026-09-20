-- Stock adjustments the copilot proposes, and the record of who decided them.
--
-- The agent's one write tool creates a row here; it never moves stock. Approving
-- runs the ordinary AdjustStockUseCase, so an agent-originated adjustment goes
-- through the same transaction, the same guards and the same ledger row as one a
-- person types in — see docs/adr/0024.
--
-- There is deliberately no `org_id`. Stock belongs to the supplier (the internal
-- organisation); `inventories` and `warehouses` have no org dimension, so such a
-- column would only suggest a boundary that does not exist.
CREATE TABLE stock_adjustment_proposals (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id             uuid NOT NULL REFERENCES products(id),
  warehouse_id           uuid NOT NULL REFERENCES warehouses(id),
  -- Signed, and never zero: a proposal that changes nothing is a mistake, not a no-op.
  delta_qty              integer NOT NULL CHECK (delta_qty <> 0),
  reason                 text NOT NULL,
  -- The agent's own explanation, kept verbatim so a reviewer sees what it argued.
  rationale              text,
  -- The conversation this came out of. No foreign key: chat sessions live in the
  -- `ai` schema, which is separable from `commerce` by design (docs/adr/0002).
  session_id             uuid,
  status                 text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected')),
  proposed_by_user_id    uuid NOT NULL REFERENCES users(id),
  decided_by_user_id     uuid REFERENCES users(id),
  decided_at             timestamptz,
  -- The ledger row an approval produced, completing the trail:
  -- conversation → proposal → approver → ledger.
  applied_transaction_id uuid REFERENCES inventory_transactions(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- Nobody approves their own proposal. In the database rather than only in the
  -- use case, because this is the guarantee the whole human-in-the-loop design
  -- rests on: a second person looked at it.
  CONSTRAINT chk_no_self_decision
    CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> proposed_by_user_id),
  -- A decided proposal records who and when; a pending one records neither.
  CONSTRAINT chk_decision_is_complete
    CHECK ((status = 'pending') = (decided_by_user_id IS NULL AND decided_at IS NULL))
);

-- The review queue: pending first, oldest waiting at the top of that.
CREATE INDEX idx_proposals_status_created
  ON stock_adjustment_proposals (status, created_at DESC);
