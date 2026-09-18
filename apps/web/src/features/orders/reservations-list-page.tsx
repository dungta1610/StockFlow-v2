import type { OrderView } from '@stockflow/contracts';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { EmptyState, ErrorState, ErrorText, LoadingRows } from '@/components/page-state';
import { Button, Card, Label, Select, Table, Td, Th } from '@/components/ui/primitives';
import { formatDateTime, relativeMinutes } from '@/lib/format';
import { OrderStatusBadge } from './order-status';
import { useOrderAction, useOrders, useOrganizations } from './orders-api';

/** Selectable windows for "expiring within". `all` still sorts soonest-first (it just
 * widens the window past any real hold, since v1's TTL is far shorter). */
const WINDOWS = { '15': 15, '30': 30, '60': 60, all: 10_080 } as const;
type WindowKey = keyof typeof WINDOWS;
const isWindowKey = (v: unknown): v is WindowKey => typeof v === 'string' && v in WINDOWS;

export interface ReservationsSearch {
  page?: number;
  within?: WindowKey;
}

export function validateReservationsSearch(raw: Record<string, unknown>): ReservationsSearch {
  const page = Number(raw.page);
  return {
    page: Number.isInteger(page) && page > 1 ? page : undefined,
    within: isWindowKey(raw.within) ? raw.within : undefined,
  };
}

export function ReservationsListPage() {
  const search = useSearch({ from: '/authed/reservations' });
  const navigate = useNavigate({ from: '/reservations' });
  const page = search.page ?? 1;
  const within = search.within ?? '30';
  const orders = useOrders({ page, status: 'reserved', expires_within_minutes: WINDOWS[within] });
  const orgs = useOrganizations();
  const orgCode = (id: string) => orgs.data?.find((o) => o.id === id)?.code ?? id.slice(0, 8);

  const setFilter = (patch: ReservationsSearch) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: patch.page && patch.page > 1 ? patch.page : undefined }) });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Reservations</h1>
        <p className="text-sm text-muted-foreground">Held stock waiting on payment, soonest to expire first.</p>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b p-3">
          <Label htmlFor="res-window" className="text-xs text-muted-foreground">
            Expiring within
          </Label>
          <Select
            id="res-window"
            className="w-auto"
            value={within}
            onChange={(e) => setFilter({ within: e.target.value as WindowKey })}
          >
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">60 minutes</option>
            <option value="all">All holds</option>
          </Select>
        </div>

        {orders.isPending ? (
          <LoadingRows />
        ) : orders.isError ? (
          <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />
        ) : orders.data.data.length === 0 ? (
          <EmptyState title="Nothing expiring">No reserved order's hold falls in this window.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Buyer</Th>
                <Th>Status</Th>
                <Th>Hold ends</Th>
                <Th>Time left</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {orders.data.data.map((o) => (
                <ReservationRow key={o.id} order={o} orgCode={orgCode(o.buyer_org_id)} />
              ))}
            </tbody>
          </Table>
        )}

        <div className="flex items-center justify-between p-3 text-sm">
          <span className="text-muted-foreground">Page {page}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setFilter({ page: page - 1 })}>
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={(orders.data?.data.length ?? 0) < 20}
              onClick={() => setFilter({ page: page + 1 })}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ReservationRow({ order, orgCode }: { order: OrderView; orgCode: string }) {
  const action = useOrderAction(order.id);
  return (
    <tr className="hover:bg-muted/50">
      <Td>
        <Link
          to="/orders/$orderId"
          params={{ orderId: order.id }}
          className="font-mono text-xs whitespace-nowrap underline-offset-2 hover:underline"
        >
          {order.order_code}
        </Link>
      </Td>
      <Td className="whitespace-nowrap">{orgCode}</Td>
      <Td>
        <OrderStatusBadge status={order.status} />
      </Td>
      <Td className="whitespace-nowrap">{formatDateTime(order.reservation_expires_at)}</Td>
      <Td className="whitespace-nowrap font-medium">
        {order.reservation_expires_at ? relativeMinutes(order.reservation_expires_at) : '—'}
      </Td>
      <Td>
        <div className="flex flex-col items-start gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={action.isPending}
            onClick={() => {
              if (window.confirm(`Expire ${order.order_code} now? The held stock goes back immediately.`)) {
                action.mutate('expire');
              }
            }}
          >
            {action.isPending ? 'Expiring…' : 'Expire now'}
          </Button>
          {action.isError && <ErrorText error={action.error} />}
        </div>
      </Td>
    </tr>
  );
}
