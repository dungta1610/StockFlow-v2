import type { OrderView } from '@stockflow/contracts';
import { Badge, Table, Td, Th } from '@/components/ui/primitives';
import { formatDateTime, relativeMinutes } from '@/lib/format';

export type DerivedReservationStatus = 'held' | 'released' | 'consumed';

/**
 * Every order line holds exactly one reservation, and its status always mirrors the
 * order's own status — enforced by the application (`OrderTransitions.apply`
 * settles every held reservation of an order in the same transaction as its status
 * change, one status for all of them, no partial-line path in v1) and checked by
 * `stockInvariantViolations` in apps/api/test/helpers/ordering-fixtures.ts, "every
 * reservation matches its order status". So the order's own fields are enough to
 * render its holds; no separate reservations endpoint is needed.
 */
export function reservationStatusFor(status: OrderView['status']): DerivedReservationStatus {
  if (status === 'reserved' || status === 'paid') return 'held';
  if (status === 'fulfilled') return 'consumed';
  return 'released';
}

const TONE: Record<DerivedReservationStatus, 'blue' | 'neutral' | 'green'> = {
  held: 'blue',
  released: 'neutral',
  consumed: 'green',
};

/** The stock this order holds, one row per line — the reservations behind the order. */
export function OrderReservations({ order }: { order: OrderView }) {
  const status = reservationStatusFor(order.status);
  return (
    <Table>
      <thead>
        <tr>
          <Th>SKU</Th>
          <Th className="text-right">Qty held</Th>
          <Th>Status</Th>
          <Th>Hold ends</Th>
        </tr>
      </thead>
      <tbody>
        {order.items.map((i) => (
          <tr key={i.id}>
            <Td className="font-mono text-xs">{i.sku}</Td>
            <Td className="text-right">{i.quantity}</Td>
            <Td>
              <Badge tone={TONE[status]}>{status}</Badge>
            </Td>
            <Td className="whitespace-nowrap text-muted-foreground">
              {/* Only a `reserved` order's hold is still an active deadline — a `paid`
                  order is also "held" (nothing has released the stock yet) but the
                  sweep never touches it, so its old reservation_expires_at is stale
                  and would misleadingly read as overdue. */}
              {order.status === 'reserved' && order.reservation_expires_at
                ? `${formatDateTime(order.reservation_expires_at)} (${relativeMinutes(order.reservation_expires_at)})`
                : '—'}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
