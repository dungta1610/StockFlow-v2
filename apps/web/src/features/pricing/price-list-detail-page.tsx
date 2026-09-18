import type { PriceListView } from '@stockflow/contracts';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState, ErrorText, LoadingRows } from '@/components/page-state';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Table, Td, Th } from '@/components/ui/primitives';
import { formatDateTime, formatMoney } from '@/lib/format';
import { isOpsAdmin, useRequiredSession } from '../auth/session';
import { useActiveProducts } from '../catalog/catalog-api';
import { useOrganizations } from '../orgs/orgs-api';
import { useArchivePriceList, usePriceList, useUpsertPriceListItems } from './pricing-api';

export function PriceListDetailPage() {
  const { priceListId } = useParams({ from: '/authed/price-lists/$priceListId' });
  const session = useRequiredSession();
  const priceList = usePriceList(priceListId);

  return (
    <div className="flex flex-col gap-4">
      <Link to="/price-lists" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Price lists
      </Link>
      {priceList.isPending ? (
        <Card>
          <LoadingRows rows={6} />
        </Card>
      ) : priceList.isError ? (
        <Card>
          <ErrorState error={priceList.error} onRetry={() => void priceList.refetch()} />
        </Card>
      ) : (
        <PriceListDetail list={priceList.data} canWrite={isOpsAdmin(session)} />
      )}
    </div>
  );
}

function PriceListDetail({ list, canWrite }: { list: PriceListView; canWrite: boolean }) {
  const archive = useArchivePriceList(list.id);
  const orgs = useOrganizations();
  const org = list.org_id ? orgs.data?.find((o) => o.id === list.org_id) : undefined;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{list.name}</h1>
        <Badge tone={list.status === 'active' ? 'green' : 'neutral'}>{list.status}</Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Scope</dt>
              <dd>{list.org_id ? (org ? `${org.code} — ${org.name}` : `Organisation ${list.org_id.slice(0, 8)}…`) : 'Default (all buyers)'}</dd>
              <dt className="text-muted-foreground">Priority</dt>
              <dd>{list.priority}</dd>
              <dt className="text-muted-foreground">Valid from</dt>
              <dd>{formatDateTime(list.valid_from)}</dd>
              <dt className="text-muted-foreground">Valid to</dt>
              <dd>{list.valid_to ? formatDateTime(list.valid_to) : 'No end date'}</dd>
              <dt className="text-muted-foreground">Updated</dt>
              <dd>{formatDateTime(list.updated_at)}</dd>
            </dl>
          </CardContent>
        </Card>

        {canWrite && list.status === 'active' && (
          <Card>
            <CardHeader>
              <CardTitle>Archive</CardTitle>
              <p className="text-xs text-muted-foreground">An archived list no longer prices new quotes or orders.</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button
                variant="outline"
                disabled={archive.isPending}
                className="self-start"
                onClick={() => {
                  if (window.confirm(`Archive "${list.name}"? This cannot be undone.`)) archive.mutate();
                }}
              >
                {archive.isPending ? 'Archiving…' : 'Archive price list'}
              </Button>
              {archive.isError && <ErrorText error={archive.error} />}
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tiers</CardTitle>
          <p className="text-xs text-muted-foreground">Per product, the price applies from its min quantity up to the next tier.</p>
        </CardHeader>
        {!list.items || list.items.length === 0 ? (
          <EmptyState title="No tiers yet">{canWrite ? 'Add one below.' : 'Ops admin can add tiers here.'}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>SKU</Th>
                <Th className="text-right">Min qty</Th>
                <Th className="text-right">Unit price</Th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((i) => (
                <tr key={i.id}>
                  <Td className="font-mono text-xs">{i.sku}</Td>
                  <Td className="text-right">{i.min_qty}</Td>
                  <Td className="text-right whitespace-nowrap">{formatMoney(i.unit_price)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {canWrite && list.status === 'active' && <AddTierForm priceListId={list.id} />}
    </>
  );
}

function AddTierForm({ priceListId }: { priceListId: string }) {
  const products = useActiveProducts();
  const upsert = useUpsertPriceListItems(priceListId);
  const [productId, setProductId] = useState('');
  const [minQty, setMinQty] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const qty = Number(minQty);
  const valid = Boolean(productId) && Number.isSafeInteger(qty) && qty >= 1 && unitPrice.trim() !== '';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add or update a tier</CardTitle>
        <p className="text-xs text-muted-foreground">Same product and min quantity replaces the existing tier's price.</p>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            upsert.mutate(
              { items: [{ product_id: productId, min_qty: qty, unit_price: unitPrice.trim() }] },
              { onSuccess: () => setUnitPrice('') },
            );
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Product</Label>
            <Select aria-label="Product" value={productId} onChange={(e) => setProductId(e.target.value)} disabled={products.isPending}>
              <option value="">Choose a product</option>
              {products.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Min qty</Label>
            <Input aria-label="Minimum quantity" type="number" min={1} step={1} value={minQty} onChange={(e) => setMinQty(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Unit price (VND)</Label>
            <Input aria-label="Unit price" inputMode="decimal" placeholder="e.g. 58000.00" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
          </div>
          <Button type="submit" disabled={!valid || upsert.isPending}>
            {upsert.isPending ? 'Saving…' : 'Save tier'}
          </Button>
        </form>
        {upsert.isError && (
          <div className="mt-2">
            <ErrorText error={upsert.error} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
