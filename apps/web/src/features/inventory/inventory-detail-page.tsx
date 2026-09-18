import type { AdjustStockRequest, InventoryView } from '@stockflow/contracts';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { ErrorState, ErrorText, LoadingRows } from '@/components/page-state';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@/components/ui/primitives';
import { formatDateTime } from '@/lib/format';
import { useAdjustStock, useInventoryDetail, useInventoryLedger } from './inventory-api';
import { LedgerTimeline } from './ledger-timeline';

export function InventoryDetailPage() {
  const { inventoryId } = useParams({ from: '/authed/inventory/$inventoryId' });
  const inventory = useInventoryDetail(inventoryId);

  return (
    <div className="flex flex-col gap-4">
      <Link to="/inventory" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Inventory
      </Link>
      {inventory.isPending ? (
        <Card>
          <LoadingRows rows={6} />
        </Card>
      ) : inventory.isError ? (
        <Card>
          <ErrorState error={inventory.error} onRetry={() => void inventory.refetch()} />
        </Card>
      ) : (
        <InventoryDetail inventory={inventory.data} />
      )}
    </div>
  );
}

function InventoryDetail({ inventory }: { inventory: InventoryView }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-xl font-semibold">{inventory.sku}</h1>
        <span className="text-sm text-muted-foreground">at {inventory.warehouse_code}</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Stock level</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Available</dt>
              <dd className="font-medium">{inventory.available_qty}</dd>
              <dt className="text-muted-foreground">Reserved</dt>
              <dd className="font-medium">{inventory.reserved_qty}</dd>
              <dt className="text-muted-foreground">Version</dt>
              <dd>{inventory.version}</dd>
              <dt className="text-muted-foreground">Updated</dt>
              <dd>{formatDateTime(inventory.updated_at)}</dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd>{formatDateTime(inventory.created_at)}</dd>
            </dl>
          </CardContent>
        </Card>

        <AdjustStockForm inventory={inventory} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Ledger</CardTitle>
          <p className="text-xs text-muted-foreground">The latest 100 reserves, releases, consumes and manual adjustments, newest first.</p>
        </CardHeader>
        <InventoryLedger inventoryId={inventory.id} />
      </Card>
    </>
  );
}

function AdjustStockForm({ inventory }: { inventory: InventoryView }) {
  const adjust = useAdjustStock();
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const qty = Number(quantity);
  const valid = Number.isSafeInteger(qty) && qty !== 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Adjust stock</CardTitle>
        <p className="text-xs text-muted-foreground">A signed delta, not a new level. Recorded as a manual adjustment in the ledger.</p>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            const body: AdjustStockRequest = {
              product_id: inventory.product_id,
              warehouse_id: inventory.warehouse_id,
              quantity: qty,
              reason: reason.trim(),
            };
            adjust.mutate(body, {
              onSuccess: () => {
                setQuantity('');
                setReason('');
              },
            });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adjust-qty">Quantity delta</Label>
            <Input
              id="adjust-qty"
              type="number"
              step={1}
              placeholder="e.g. 50 or -12"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adjust-reason">Reason</Label>
            <Input id="adjust-reason" placeholder="e.g. Cycle count correction" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {adjust.isError && <ErrorText error={adjust.error} />}
          <Button type="submit" disabled={!valid || adjust.isPending} className="self-start">
            {adjust.isPending ? 'Recording…' : 'Record adjustment'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function InventoryLedger({ inventoryId }: { inventoryId: string }) {
  const ledger = useInventoryLedger(inventoryId);
  if (ledger.isPending) return <LoadingRows rows={4} />;
  if (ledger.isError) return <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} />;
  return <LedgerTimeline transactions={ledger.data} />;
}
