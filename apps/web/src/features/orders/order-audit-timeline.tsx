import { EmptyState, ErrorState, LoadingRows } from '@/components/page-state';
import { Card, CardHeader, CardTitle } from '@/components/ui/primitives';
import { formatDateTime } from '@/lib/format';
import { useAuditLog } from '../audit/audit-api';

/** ops_admin only: render this only behind an isOpsAdmin check (see order-detail-page.tsx). */
export function OrderAuditTimeline({ orderId }: { orderId: string }) {
  const audit = useAuditLog({ aggregate_type: 'order', aggregate_id: orderId }, true);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Event timeline</CardTitle>
        <p className="text-xs text-muted-foreground">From the audit log: every status change recorded for this order.</p>
      </CardHeader>
      {audit.isPending ? (
        <LoadingRows rows={3} />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : audit.data.length === 0 ? (
        <EmptyState title="No events yet" />
      ) : (
        <ol className="flex flex-col gap-3 p-4">
          {audit.data.map((e) => (
            <li key={e.id} className="flex flex-col gap-1 border-l-2 pl-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.event_type}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(e.occurred_at)}</span>
              </div>
              {Object.keys(e.summary).length > 0 && (
                <pre className="w-full overflow-x-auto rounded bg-muted p-2 text-xs">{JSON.stringify(e.summary, null, 2)}</pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
