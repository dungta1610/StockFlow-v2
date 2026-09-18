import { type OrderStatusValue, orderStatusSchema } from '@stockflow/contracts';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingRows } from '@/components/page-state';
import { Button, Card, Input, Select, Table, Td, Th } from '@/components/ui/primitives';
import { formatDateTime, formatMoney, relativeMinutes } from '@/lib/format';
import { isOps, useRequiredSession } from '../auth/session';
import { OrderStatusBadge } from './order-status';
import { useOrders, useOrganizations } from './orders-api';

/** The five statuses v1 produces; filtering by the others would always be empty. */
const FILTERABLE: OrderStatusValue[] = ['reserved', 'paid', 'fulfilled', 'cancelled', 'expired'];

export function OrdersListPage() {
  const session = useRequiredSession();
  const ops = isOps(session);
  const search = useSearch({ from: '/authed/orders' });
  const navigate = useNavigate({ from: '/orders' });
  const [code, setCode] = useState(search.order_code ?? '');

  const page = search.page ?? 1;
  const orders = useOrders({ ...search, page });
  const orgs = useOrganizations();
  const orgCode = (id: string) => orgs.data?.find((o) => o.id === id)?.code ?? id.slice(0, 8);

  const setFilter = (patch: OrdersSearch) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: patch.page && patch.page > 1 ? patch.page : undefined }) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Orders</h1>
          <p className="text-sm text-muted-foreground">
            {ops ? 'Orders from every buyer organisation.' : `Orders of ${session.acting_as.org_code}.`}
          </p>
        </div>
        {!ops && (
          <Link to="/orders/new">
            <Button>
              <Plus className="size-4" /> New order
            </Button>
          </Link>
        )}
      </div>

      <Card>
        <form
          className="grid gap-3 border-b p-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void setFilter({ order_code: code.trim() || undefined });
          }}
        >
          <Input placeholder="Order code, e.g. ORD-20260918-000001" value={code} onChange={(e) => setCode(e.target.value)} />
          <Select
            value={search.status ?? ''}
            onChange={(e) => setFilter({ status: (e.target.value || undefined) as OrderStatusValue | undefined })}
            aria-label="Status"
          >
            <option value="">All statuses</option>
            {FILTERABLE.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          {ops ? (
            <Select
              value={search.buyer_org_id ?? ''}
              onChange={(e) => setFilter({ buyer_org_id: e.target.value || undefined })}
              aria-label="Buyer"
            >
              <option value="">All buyers</option>
              {orgs.data
                ?.filter((o) => o.type === 'buyer')
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.code} — {o.name}
                  </option>
                ))}
            </Select>
          ) : (
            <div />
          )}
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>

        {orders.isPending ? (
          <LoadingRows />
        ) : orders.isError ? (
          <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />
        ) : orders.data.data.length === 0 ? (
          <EmptyState title="No orders match">
            {ops ? 'Buyers place orders; they show up here.' : 'Place one with “New order”.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                {ops && <Th>Buyer</Th>}
                <Th>Status</Th>
                <Th className="text-right">Total</Th>
                <Th>Lines</Th>
                <Th>Created</Th>
                <Th>Hold ends</Th>
              </tr>
            </thead>
            <tbody>
              {orders.data.data.map((o) => (
                <tr key={o.id} className="hover:bg-muted/50">
                  <Td>
                    <Link to="/orders/$orderId" params={{ orderId: o.id }} className="font-mono text-xs whitespace-nowrap underline-offset-2 hover:underline">
                      {o.order_code}
                    </Link>
                  </Td>
                  {ops && <Td className="whitespace-nowrap">{orgCode(o.buyer_org_id)}</Td>}
                  <Td>
                    <OrderStatusBadge status={o.status} />
                  </Td>
                  <Td className="text-right whitespace-nowrap">{formatMoney(o.total)}</Td>
                  <Td>{o.items.length}</Td>
                  <Td className="whitespace-nowrap">{formatDateTime(o.created_at)}</Td>
                  <Td className="whitespace-nowrap text-muted-foreground">
                    {o.status === 'reserved' && o.reservation_expires_at ? relativeMinutes(o.reservation_expires_at) : '—'}
                  </Td>
                </tr>
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

/** URL search params of the list, validated so a hand-edited URL cannot break the page. */
export interface OrdersSearch {
  page?: number;
  status?: OrderStatusValue;
  order_code?: string;
  buyer_org_id?: string;
}

export function validateOrdersSearch(raw: Record<string, unknown>): OrdersSearch {
  const status = orderStatusSchema.safeParse(raw.status);
  const page = Number(raw.page);
  return {
    page: Number.isInteger(page) && page > 1 ? page : undefined,
    status: status.success ? status.data : undefined,
    order_code: typeof raw.order_code === 'string' && raw.order_code ? raw.order_code : undefined,
    buyer_org_id: typeof raw.buyer_org_id === 'string' && raw.buyer_org_id ? raw.buyer_org_id : undefined,
  };
}
