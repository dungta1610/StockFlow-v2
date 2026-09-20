# 0024 — The agent proposes; a person decides

**Status:** accepted · 2026-09-20

## Context
The copilot is useful precisely where it is dangerous. Noticing that a SKU has come up
short in three consecutive counts, and that the movement history shows no release to
explain it, is exactly the work worth automating. Acting on that conclusion by editing
stock is a different thing entirely.

Stock is not an opinion. Inventory and ordering are built around invariants — no overselling
under concurrency, every change leaving a ledger row, holds released exactly once — that a
whole phase of work exists to protect. An agent writing directly would put those behind a
model's judgement in exchange for saving a reviewer one click.

## Decision

**The agent's only write tool creates a proposal.** `propose_stock_adjustment` inserts a
row in `stock_adjustment_proposals` and changes no stock. The tool's own description tells
the model to say so, and `test/copilot/propose-does-not-write-stock.spec.ts` checks that
the quantities and the ledger are untouched afterwards.

**Approving runs the ordinary use case.** `ApproveProposalUseCase` calls
`AdjustStockUseCase` — same transaction, same guards, same ledger row as a correction typed
in by a person. An agent-originated change is not a different kind of change, and does not
get a different code path.

Four guards, each where it can actually hold:

| Guarantee | Where it lives |
|---|---|
| Only an `ops_admin` approves | `assertRole` in the use case, plus `@Roles` on the route. The use case is the one that counts — a tool reaches use cases without HTTP |
| Nobody decides their own proposal | Checked in the use case for a readable error, and by `chk_no_self_decision` in the database, which cannot be routed around |
| A role only counts in the right kind of organisation | `chk_role_matches_org_type` from Phase 01: a buyer admin cannot grant `ops` to their own staff |
| Approving twice adjusts stock once | The row is locked `FOR UPDATE` and its status re-read inside the same transaction as the adjustment |

**The trail is complete and stored.** `session_id` → `rationale` → `decided_by_user_id` →
`applied_transaction_id` answers, from one table: which conversation raised this, what the
agent argued, who agreed, and which ledger row resulted.

## Alternatives considered
- **Let the agent adjust stock directly.** Rejected: high consequence, low marginal value.
  The hard part is noticing and explaining; approving is the cheap part.
- **Let it adjust within a small threshold.** Rejected: a threshold is a number somebody
  raises later under pressure, and the damage of a wrong small adjustment is not small —
  it is a wrong ledger that every subsequent count is reconciled against.

## Consequences
- The copilot cannot change the business state on its own. Anything it wants done, a person
  does, having seen the reasoning.
- There is a queue to work: `GET /ops/stock-adjustment-proposals`, ordered pending-first.
- Rejecting is recorded rather than deleted, so a proposal a person disagreed with stays
  visible — which is what makes the queue evidence about the agent's judgement over time.
- Changing this means changing this ADR first. "The approval step was slowing us down" is a
  decision, not an implementation detail.
