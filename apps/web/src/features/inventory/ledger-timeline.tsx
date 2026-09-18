import type { InventoryTransactionView } from '@stockflow/contracts';
import { Badge, Table, Td, Th } from '@/components/ui/primitives';
import { formatDateTime } from '@/lib/format';
import { EmptyState } from '@/components/page-state';

/**
 * A ledger row ready to render: before/after pairs plus whether the movement grew
 * or shrank each side, so the badge can be coloured without re-deriving it in JSX.
 * Pulled out as a pure function so the before/after logic is testable without
 * mounting the component (see test/ledger-timeline.spec.ts).
 */
export interface LedgerRow {
  id: string;
  when: string;
  txnType: InventoryTransactionView['txn_type'];
  quantity: number;
  reason: string;
  available: { before: number; after: number; direction: 'up' | 'down' | 'flat' };
  reserved: { before: number; after: number; direction: 'up' | 'down' | 'flat' };
}

const direction = (before: number, after: number): 'up' | 'down' | 'flat' =>
  after > before ? 'up' : after < before ? 'down' : 'flat';

export function ledgerRows(transactions: InventoryTransactionView[]): LedgerRow[] {
  return transactions.map((t) => ({
    id: t.id,
    when: t.created_at,
    txnType: t.txn_type,
    quantity: t.quantity,
    reason: t.reason,
    available: {
      before: t.before_available_qty,
      after: t.after_available_qty,
      direction: direction(t.before_available_qty, t.after_available_qty),
    },
    reserved: {
      before: t.before_reserved_qty,
      after: t.after_reserved_qty,
      direction: direction(t.before_reserved_qty, t.after_reserved_qty),
    },
  }));
}

function ChangeCell({ before, after, direction: dir }: LedgerRow['available']) {
  const tone = dir === 'up' ? 'green' : dir === 'down' ? 'red' : 'neutral';
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {before} <span className="text-muted-foreground">→</span> {after}
      {dir !== 'flat' && <Badge tone={tone}>{dir === 'up' ? '+' : ''}{after - before}</Badge>}
    </span>
  );
}

/** The append-only ledger for one stock record, before/after on both sides of every move. */
export function LedgerTimeline({ transactions }: { transactions: InventoryTransactionView[] }) {
  if (transactions.length === 0) return <EmptyState title="No movements yet" />;
  const rows = ledgerRows(transactions);
  return (
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
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="whitespace-nowrap">{formatDateTime(r.when)}</Td>
            <Td>{r.txnType}</Td>
            <Td className="text-right whitespace-nowrap">{r.quantity > 0 ? `+${r.quantity}` : r.quantity}</Td>
            <Td className="text-right"><ChangeCell {...r.available} /></Td>
            <Td className="text-right"><ChangeCell {...r.reserved} /></Td>
            <Td className="max-w-[16rem] truncate text-xs text-muted-foreground" title={r.reason || undefined}>
              {r.reason || '—'}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
