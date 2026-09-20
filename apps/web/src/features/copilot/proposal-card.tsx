import type { StockAdjustmentProposalView } from '@stockflow/contracts';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import { ErrorText } from '@/components/page-state';
import { formatDateTime } from '@/lib/format';
import { useDecideProposal } from './copilot-api';

const STATUS_TONE = { pending: 'amber', approved: 'green', rejected: 'neutral' } as const;

/**
 * A stock change the assistant suggested, waiting on a person.
 *
 * The card shows the agent's own rationale rather than summarising it: the
 * reviewer is being asked to agree with an argument, and an argument paraphrased
 * by the interface is not the one that was made.
 *
 * Approve only appears for `ops_admin`, and only on a pending proposal. That is a
 * convenience, not the control — the API refuses the same call, and refuses a
 * self-approval whatever the button says (docs/adr/0024).
 */
export function ProposalCard({
  proposal,
  canApprove,
}: {
  proposal: StockAdjustmentProposalView;
  canApprove: boolean;
}) {
  const approve = useDecideProposal('approve');
  const reject = useDecideProposal('reject');
  const pending = proposal.status === 'pending';
  const busy = approve.isPending || reject.isPending;

  return (
    <Card className="border-amber-500/40">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-sm">
            Stock adjustment · {proposal.sku} at {proposal.warehouse_code}
          </CardTitle>
          <p className="text-sm text-muted-foreground">{proposal.reason}</p>
        </div>
        <Badge tone={STATUS_TONE[proposal.status]}>{proposal.status}</Badge>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <p className="text-2xl font-semibold tabular-nums">
          {proposal.delta_qty > 0 ? `+${proposal.delta_qty}` : proposal.delta_qty}
          <span className="ml-2 text-sm font-normal text-muted-foreground">units</span>
        </p>

        {proposal.rationale && (
          <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground">{proposal.rationale}</blockquote>
        )}

        {pending ? (
          <div className="flex flex-wrap items-center gap-2">
            {canApprove && (
              <Button disabled={busy} onClick={() => approve.mutate(proposal.id)}>
                {approve.isPending ? 'Approving…' : 'Approve'}
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => reject.mutate(proposal.id)}>
              {reject.isPending ? 'Rejecting…' : 'Reject'}
            </Button>
            {!canApprove && (
              <span className="text-xs text-muted-foreground">An ops admin has to approve this.</span>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {proposal.status === 'approved' ? 'Approved' : 'Rejected'}
            {proposal.decided_at && ` · ${formatDateTime(proposal.decided_at)}`}
          </p>
        )}

        {approve.error && <ErrorText error={approve.error} />}
        {reject.error && <ErrorText error={reject.error} />}
      </CardContent>
    </Card>
  );
}
