import type { OrderStatusValue } from '@stockflow/contracts';
import { Badge } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

const TONE: Record<OrderStatusValue, 'neutral' | 'blue' | 'green' | 'amber' | 'red'> = {
  pending: 'neutral',
  reserved: 'blue',
  awaiting_payment: 'neutral',
  paid: 'amber',
  fulfilled: 'green',
  completed: 'green',
  cancelled: 'red',
  expired: 'neutral',
};

export function OrderStatusBadge({ status }: { status: OrderStatusValue }) {
  return <Badge tone={TONE[status]}>{status}</Badge>;
}

/**
 * The five statuses v1 produces, laid out as the lifecycle (ADR 0016). The three
 * enum values nothing creates are not drawn.
 */
export const MAIN_PATH: OrderStatusValue[] = ['reserved', 'paid', 'fulfilled'];
export const SIDE_EXITS: OrderStatusValue[] = ['cancelled', 'expired'];
/** Every status the state machine renders — exactly the five v1 produces. */
export const RENDERED_STATUSES: OrderStatusValue[] = [...MAIN_PATH, ...SIDE_EXITS];

/**
 * Which statuses are "reached" on the path to `status`, for highlighting the
 * lifecycle diagram. Pulled out as a pure function so it is testable without
 * mounting the component (see test/order-state-machine.spec.ts).
 */
export function reachedStatuses(status: OrderStatusValue): Set<OrderStatusValue> {
  const reached = new Set<OrderStatusValue>(['reserved']);
  if (status === 'paid' || status === 'fulfilled') reached.add('paid');
  if (status === 'fulfilled') reached.add('fulfilled');
  if (SIDE_EXITS.includes(status)) reached.add(status);
  return reached;
}

export function OrderStateMachine({ status }: { status: OrderStatusValue }) {
  const reached = reachedStatuses(status);

  const node = (s: OrderStatusValue) => (
    <div
      key={s}
      className={cn(
        'rounded-md border px-3 py-1.5 text-xs font-medium',
        s === status && 'border-primary bg-primary text-primary-foreground',
        s !== status && reached.has(s) && 'border-primary/60',
        !reached.has(s) && 'border-dashed text-muted-foreground opacity-60',
      )}
      aria-current={s === status ? 'step' : undefined}
    >
      {s}
    </div>
  );

  return (
    <div className="flex flex-col gap-2" aria-label={`Order status: ${status}`}>
      <div className="flex flex-wrap items-center gap-2">
        {MAIN_PATH.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <span className="text-muted-foreground">→</span>}
            {node(s)}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-4 text-muted-foreground">
        <span className="text-xs">reserved ↳</span>
        {SIDE_EXITS.map(node)}
      </div>
    </div>
  );
}
