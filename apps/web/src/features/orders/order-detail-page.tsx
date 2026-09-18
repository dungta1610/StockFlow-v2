import type { OrderView, SessionView } from '@stockflow/contracts';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { EmptyState, ErrorState, ErrorText, LoadingRows } from '@/components/page-state';
import { Button, Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from '@/components/ui/primitives';
import { formatDateTime, formatMoney, relativeMinutes } from '@/lib/format';
import { isOps, isOpsAdmin, useRequiredSession } from '../auth/session';
import { OrderAuditTimeline } from './order-audit-timeline';
import { OrderReservations } from './order-reservations';
import { OrderStateMachine, OrderStatusBadge } from './order-status';
import { type OrderAction, useOrder, useOrderAction, useOrderLedger, useWarehouses } from './orders-api';

export function OrderDetailPage() {
  const { orderId } = useParams({ from: '/authed/orders/$orderId' });
  const session = useRequiredSession();
  const order = useOrder(orderId);

  return (
    <div className="flex flex-col gap-4">
      <Link to="/orders" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Orders
      </Link>
      {order.isPending ? (
        <Card>
          <LoadingRows rows={6} />
        </Card>
      ) : order.isError ? (
        <Card>
          <ErrorState error={order.error} onRetry={() => void order.refetch()} />
        </Card>
      ) : (
        <OrderDetail order={order.data} session={session} />
      )}
    </div>
  );
}

function OrderDetail({ order, session }: { order: OrderView; session: SessionView }) {
  const ops = isOps(session);
  const warehouses = useWarehouses();
  const warehouse = warehouses.data?.find((w) => w.id === order.warehouse_id);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-xl font-semibold">{order.order_code}</h1>
        <OrderStatusBadge status={order.status} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Lifecycle</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <OrderStateMachine status={order.status} />
            <OrderActions order={order} ops={ops} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Warehouse</dt>
              <dd>{warehouse ? `${warehouse.code} — ${warehouse.name}` : order.warehouse_id}</dd>
              <dt className="text-muted-foreground">Total</dt>
              <dd className="font-medium">{formatMoney(order.total)}</dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd>{formatDateTime(order.created_at)}</dd>
              <dt className="text-muted-foreground">Hold ends</dt>
              <dd>
                {/* Once an order leaves `reserved` the sweep no longer acts on its
                    reservation_expires_at, so the original deadline is stale — show
                    it only while it is still a live deadline. */}
                {order.status === 'reserved' && order.reservation_expires_at ? (
                  <>
                    {formatDateTime(order.reservation_expires_at)}
                    <span className="text-muted-foreground"> ({relativeMinutes(order.reservation_expires_at)})</span>
                  </>
                ) : (
                  '—'
                )}
              </dd>
              <dt className="text-muted-foreground">Paid</dt>
              <dd>{formatDateTime(order.paid_at)}</dd>
              <dt className="text-muted-foreground">Fulfilled</dt>
              <dd>{formatDateTime(order.fulfilled_at)}</dd>
              <dt className="text-muted-foreground">Cancelled</dt>
              <dd>{formatDateTime(order.cancelled_at)}</dd>
              <dt className="text-muted-foreground">Expired</dt>
              <dd>{formatDateTime(order.expired_at)}</dd>
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <Table>
          <thead>
            <tr>
              <Th>SKU</Th>
              <Th className="text-right">Qty</Th>
              <Th className="text-right">Unit price</Th>
              <Th className="text-right">Line total</Th>
              <Th>Price source</Th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((i) => (
              <tr key={i.id}>
                <Td className="font-mono text-xs">{i.sku}</Td>
                <Td className="text-right">{i.quantity}</Td>
                <Td className="text-right whitespace-nowrap">{formatMoney(i.unit_price)}</Td>
                <Td className="text-right whitespace-nowrap">{formatMoney(i.line_total)}</Td>
                <Td className="text-xs text-muted-foreground">
                  {i.price_list_item_id ? `price list item ${i.price_list_item_id.slice(0, 8)}…` : 'base price'}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reservations</CardTitle>
          <p className="text-xs text-muted-foreground">The stock this order holds, one row per line.</p>
        </CardHeader>
        <OrderReservations order={order} />
      </Card>

      {ops && <OrderLedger orderId={order.id} />}
      {isOpsAdmin(session) && <OrderAuditTimeline orderId={order.id} />}
    </>
  );
}

/** Which buttons each side sees, mirroring the use cases' role checks (ADR 0016). */
function actionsFor(order: OrderView, ops: boolean): { action: OrderAction; label: string; danger?: boolean }[] {
  if (order.status === 'reserved') {
    return ops
      ? [
          { action: 'mark-paid', label: 'Mark paid' },
          { action: 'cancel', label: 'Cancel', danger: true },
          { action: 'expire', label: 'Expire now', danger: true },
        ]
      : [{ action: 'cancel', label: 'Cancel order', danger: true }];
  }
  if (order.status === 'paid' && ops) return [{ action: 'fulfill', label: 'Fulfil (ship)' }];
  return [];
}

function OrderActions({ order, ops }: { order: OrderView; ops: boolean }) {
  const mutation = useOrderAction(order.id);
  const actions = actionsFor(order, ops);

  if (actions.length === 0) {
    return <p className="text-sm text-muted-foreground">No further action for this order.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <Button
            key={a.action}
            variant={a.danger ? 'outline' : 'default'}
            disabled={mutation.isPending}
            onClick={() => {
              if (a.danger && !window.confirm(`${a.label} ${order.order_code}? The held stock goes back.`)) return;
              mutation.mutate(a.action);
            }}
          >
            {a.label}
          </Button>
        ))}
      </div>
      {mutation.isError && <ErrorText error={mutation.error} />}
    </div>
  );
}

function OrderLedger({ orderId }: { orderId: string }) {
  const ledger = useOrderLedger(orderId, true);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Stock movements for this order</CardTitle>
        <p className="text-xs text-muted-foreground">From the append-only ledger: every reserve, release and consume.</p>
      </CardHeader>
      {ledger.isPending ? (
        <LoadingRows rows={3} />
      ) : ledger.isError ? (
        <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} />
      ) : ledger.data.length === 0 ? (
        <EmptyState title="No movements" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Type</Th>
              <Th className="text-right">Qty</Th>
              <Th className="text-right">Available</Th>
              <Th className="text-right">Reserved</Th>
              <Th>Reason</Th>
            </tr>
          </thead>
          <tbody>
            {ledger.data.map((t) => (
              <tr key={t.id}>
                <Td className="whitespace-nowrap">{formatDateTime(t.created_at)}</Td>
                <Td>{t.txn_type}</Td>
                <Td className="text-right">{t.quantity}</Td>
                <Td className="text-right whitespace-nowrap">
                  {t.before_available_qty} → {t.after_available_qty}
                </Td>
                <Td className="text-right whitespace-nowrap">
                  {t.before_reserved_qty} → {t.after_reserved_qty}
                </Td>
                <Td className="text-xs text-muted-foreground">{t.reason}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
