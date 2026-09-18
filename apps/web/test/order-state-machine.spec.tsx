import type { OrderStatusValue } from '@stockflow/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MAIN_PATH, OrderStateMachine, RENDERED_STATUSES, SIDE_EXITS, reachedStatuses } from '../src/features/orders/order-status';

describe('order state machine — the five v1 statuses only (pure logic)', () => {
  it('renders exactly the five statuses v1 produces', () => {
    expect([...RENDERED_STATUSES].sort()).toEqual(['cancelled', 'expired', 'fulfilled', 'paid', 'reserved'].sort());
  });

  it('does not render the three enum values nothing creates', () => {
    const noProducer: OrderStatusValue[] = ['pending', 'awaiting_payment', 'completed'];
    for (const status of noProducer) expect(RENDERED_STATUSES).not.toContain(status);
  });

  it('reserved: only reserved is reached', () => {
    expect(reachedStatuses('reserved')).toEqual(new Set(['reserved']));
  });

  it('paid: reserved and paid are reached, not fulfilled', () => {
    expect(reachedStatuses('paid')).toEqual(new Set(['reserved', 'paid']));
  });

  it('fulfilled: the whole main path is reached', () => {
    expect(reachedStatuses('fulfilled')).toEqual(new Set(['reserved', 'paid', 'fulfilled']));
  });

  it('cancelled: reserved plus the cancelled exit, never paid or fulfilled', () => {
    expect(reachedStatuses('cancelled')).toEqual(new Set(['reserved', 'cancelled']));
  });

  it('expired: reserved plus the expired exit', () => {
    expect(reachedStatuses('expired')).toEqual(new Set(['reserved', 'expired']));
  });
});

/**
 * Actually mounts `<OrderStateMachine />` (via `react-dom/server`, no jsdom/RTL
 * dependency needed for a static render) so a change to the component's JSX — e.g.
 * drawing an extra node, or losing the current/reached/unreached styling — fails a
 * test, not just a change to the `reachedStatuses`/`RENDERED_STATUSES` constants
 * above.
 */
describe('OrderStateMachine (rendered)', () => {
  const render = (status: OrderStatusValue) => renderToStaticMarkup(<OrderStateMachine status={status} />);
  const classesOf = (html: string, text: string): string => {
    const match = html.match(new RegExp(`<div class="([^"]*)"[^>]*>${text}</div>`));
    if (!match) throw new Error(`no node rendered for "${text}" in: ${html}`);
    return match[1]!;
  };

  it('renders a node for exactly the 5 v1 statuses, none of the 3 with no producer', () => {
    const html = render('paid');
    for (const s of RENDERED_STATUSES) expect(html).toContain(`>${s}<`);
    for (const s of ['pending', 'awaiting_payment', 'completed'] as OrderStatusValue[]) {
      expect(html).not.toContain(`>${s}<`);
    }
    // Nothing beyond the 5 main-path + side-exit nodes.
    expect((html.match(/rounded-md border/g) ?? []).length).toBe(MAIN_PATH.length + SIDE_EXITS.length);
  });

  it('marks exactly the current status with aria-current="step" and the current styling', () => {
    const html = render('paid');
    expect((html.match(/aria-current="step"/g) ?? []).length).toBe(1);
    const current = classesOf(html, 'paid');
    expect(current).toContain('bg-primary');
    expect(current).toContain('text-primary-foreground');
    expect(html).toMatch(/aria-current="step">paid<\/div>/);
  });

  it('a reached-but-not-current status gets the reached style, not the current or unreached one', () => {
    const html = render('fulfilled');
    const reserved = classesOf(html, 'reserved');
    expect(reserved).toContain('border-primary/60');
    expect(reserved).not.toContain('bg-primary');
    expect(reserved).not.toContain('border-dashed');
  });

  it('an unreached status gets the dashed/dimmed style, not current or reached', () => {
    const html = render('reserved');
    const paid = classesOf(html, 'paid');
    expect(paid).toContain('border-dashed');
    expect(paid).toContain('opacity-60');
    expect(paid).not.toContain('bg-primary');
    expect(paid).not.toContain('border-primary/60');
  });

  it('side exits follow the same current/reached/unreached rule as the main path', () => {
    const cancelled = render('cancelled');
    expect(classesOf(cancelled, 'cancelled')).toContain('bg-primary');
    expect(classesOf(cancelled, 'expired')).toContain('border-dashed');

    const reserved = render('reserved');
    expect(classesOf(reserved, 'cancelled')).toContain('border-dashed');
    expect(classesOf(reserved, 'expired')).toContain('border-dashed');
  });
});
