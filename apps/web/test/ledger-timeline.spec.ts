import type { InventoryTransactionView } from '@stockflow/contracts';
import { describe, expect, it } from 'vitest';
import { ledgerRows } from '../src/features/inventory/ledger-timeline';

const txn = (overrides: Partial<InventoryTransactionView>): InventoryTransactionView => ({
  id: 'txn-1',
  inventory_id: 'inv-1',
  product_id: 'prod-1',
  warehouse_id: 'wh-1',
  order_id: null,
  reservation_id: null,
  txn_type: 'manual_adjustment',
  quantity: 10,
  before_available_qty: 100,
  after_available_qty: 110,
  before_reserved_qty: 0,
  after_reserved_qty: 0,
  reason: 'Cycle count',
  created_by: 'user-1',
  created_at: '2026-09-19T08:00:00.000Z',
  ...overrides,
});

describe('ledgerRows', () => {
  it('carries the raw before/after pair through for each side', () => {
    const [row] = ledgerRows([txn({ before_available_qty: 100, after_available_qty: 110, before_reserved_qty: 5, after_reserved_qty: 5 })]);
    expect(row.available).toMatchObject({ before: 100, after: 110 });
    expect(row.reserved).toMatchObject({ before: 5, after: 5 });
  });

  it('marks an increase as "up"', () => {
    const [row] = ledgerRows([txn({ before_available_qty: 100, after_available_qty: 110 })]);
    expect(row.available.direction).toBe('up');
  });

  it('marks a decrease as "down"', () => {
    const [row] = ledgerRows([txn({ txn_type: 'reserve', before_available_qty: 100, after_available_qty: 90 })]);
    expect(row.available.direction).toBe('down');
  });

  it('a reserve moves stock from available to reserved: available down, reserved up', () => {
    const [row] = ledgerRows([
      txn({ txn_type: 'reserve', before_available_qty: 100, after_available_qty: 90, before_reserved_qty: 0, after_reserved_qty: 10 }),
    ]);
    expect(row.available.direction).toBe('down');
    expect(row.reserved.direction).toBe('up');
  });

  it('marks a side flat when before equals after', () => {
    const [row] = ledgerRows([txn({ before_reserved_qty: 5, after_reserved_qty: 5 })]);
    expect(row.reserved.direction).toBe('flat');
  });

  it('preserves row order and maps every transaction', () => {
    const rows = ledgerRows([txn({ id: 'a' }), txn({ id: 'b' }), txn({ id: 'c' })]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for no transactions', () => {
    expect(ledgerRows([])).toEqual([]);
  });
});
