import {
  ORDER_STATUSES,
  type OrderStatus,
  canTransition,
  isFinal,
  nextStatuses,
} from '../../src/modules/ordering/domain/order-state-machine';

// Pure: the whole lifecycle is checked without a database.
describe('order state machine', () => {
  const allowed: [OrderStatus, OrderStatus][] = [
    ['reserved', 'paid'],
    ['reserved', 'cancelled'],
    ['reserved', 'expired'],
    ['paid', 'fulfilled'],
  ];

  it('allows exactly the v1 transitions and nothing else', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const expected = allowed.some(([f, t]) => f === from && t === to);
        expect({ from, to, ok: canTransition(from, to) }).toEqual({ from, to, ok: expected });
      }
    }
  });

  it('keeps StockFlow’s refusals: a paid order cannot be cancelled or expired', () => {
    expect(canTransition('paid', 'cancelled')).toBe(false);
    expect(canTransition('paid', 'expired')).toBe(false);
  });

  it('never fulfils a cancelled or expired order', () => {
    expect(canTransition('cancelled', 'fulfilled')).toBe(false);
    expect(canTransition('expired', 'fulfilled')).toBe(false);
  });

  it('has no way into the three statuses v1 never produces', () => {
    for (const unreachable of ['pending', 'awaiting_payment', 'completed'] as const) {
      expect(ORDER_STATUSES.filter((from) => canTransition(from, unreachable))).toEqual([]);
    }
  });

  it('treats fulfilled, cancelled and expired as final', () => {
    expect(isFinal('fulfilled')).toBe(true);
    expect(isFinal('cancelled')).toBe(true);
    expect(isFinal('expired')).toBe(true);
    expect(isFinal('reserved')).toBe(false);
    expect(nextStatuses('reserved')).toEqual(['paid', 'cancelled', 'expired']);
  });
});
