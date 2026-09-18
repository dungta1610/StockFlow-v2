import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ErrorState, ErrorText, LoadingRows } from '@/components/page-state';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { useCreateOrder, useProducts, useQuote, useWarehouses } from './orders-api';

interface Line {
  key: number;
  productId: string;
  quantity: number;
}

let nextKey = 1;

/**
 * Buyers build a cart and see the server's price for it before placing the order —
 * the quote and the order use the same price resolver. There is no price input: the
 * API would ignore it anyway.
 */
export function NewOrderPage() {
  const navigate = useNavigate();
  const warehouses = useWarehouses();
  const products = useProducts();
  const create = useCreateOrder();

  const [warehouseId, setWarehouseId] = useState('');
  const [lines, setLines] = useState<Line[]>([{ key: nextKey++, productId: '', quantity: 1 }]);
  // One key per draft: a double click or a retry after a timeout replays the first
  // response instead of placing a second order. A new draft gets a new key.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const validItems = useMemo(
    () =>
      lines
        .filter((l) => l.productId && Number.isInteger(l.quantity) && l.quantity > 0)
        .map((l) => ({ product_id: l.productId, qty: l.quantity })),
    [lines],
  );
  const quote = useQuote(validItems);
  const duplicate = new Set(validItems.map((i) => i.product_id)).size !== validItems.length;

  const update = (key: number, patch: Partial<Line>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    // The cart changed: this is a different request, so it needs its own key.
    setIdempotencyKey(crypto.randomUUID());
  };

  if (warehouses.isPending || products.isPending) {
    return (
      <Card>
        <LoadingRows />
      </Card>
    );
  }
  if (warehouses.isError || products.isError) {
    return (
      <Card>
        <ErrorState error={warehouses.error ?? products.error} />
      </Card>
    );
  }

  const insufficient =
    create.error instanceof ApiError && create.error.code === 'INSUFFICIENT_STOCK'
      ? (create.error.details as { sku: string; requested: number; available: number })
      : null;

  return (
    <div className="flex flex-col gap-4">
      <Link to="/orders" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Orders
      </Link>
      <h1 className="text-xl font-semibold">New order</h1>

      <form
        className="grid gap-4 lg:grid-cols-[2fr_1fr]"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            {
              body: {
                warehouse_id: warehouseId,
                items: validItems.map((i) => ({ product_id: i.product_id, quantity: i.qty })),
              },
              idempotencyKey,
            },
            { onSuccess: (order) => void navigate({ to: '/orders/$orderId', params: { orderId: order.id } }) },
          );
        }}
      >
        <Card>
          <CardHeader>
            <CardTitle>Cart</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="warehouse">Warehouse</Label>
              <Select id="warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required>
                <option value="">Choose a warehouse</option>
                {warehouses.data.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} — {w.name}
                  </option>
                ))}
              </Select>
            </div>

            {lines.map((line) => (
              <div key={line.key} className="grid grid-cols-[1fr_6rem_auto] items-end gap-2">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Product</Label>
                  <Select aria-label="Product" value={line.productId} onChange={(e) => update(line.key, { productId: e.target.value })}>
                    <option value="">Choose a product</option>
                    {products.data.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sku} — {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Qty</Label>
                  <Input
                    aria-label="Quantity"
                    type="number"
                    min={1}
                    step={1}
                    value={line.quantity}
                    onChange={(e) => update(line.key, { quantity: Number(e.target.value) })}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove line"
                  disabled={lines.length === 1}
                  onClick={() => {
                    setLines((ls) => ls.filter((l) => l.key !== line.key));
                    setIdempotencyKey(crypto.randomUUID());
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setLines((ls) => [...ls, { key: nextKey++, productId: '', quantity: 1 }])}
            >
              <Plus className="size-4" /> Add line
            </Button>
            {duplicate && <p className="text-sm text-destructive">Each product may appear only once.</p>}
          </CardContent>
        </Card>

        <Card className="self-start">
          <CardHeader>
            <CardTitle>Your price</CardTitle>
            <p className="text-xs text-muted-foreground">Quoted by the server from your contract.</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {validItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add a product to see its price.</p>
            ) : quote.isError ? (
              <ErrorText error={quote.error} />
            ) : !quote.data ? (
              <LoadingRows rows={2} />
            ) : (
              <>
                <ul className="flex flex-col gap-2 text-sm">
                  {quote.data.lines.map((l) => (
                    <li key={l.product_id} className="flex justify-between gap-2">
                      <span className="min-w-0">
                        <span className="font-mono text-xs">{l.sku}</span> × {l.qty}
                        <span className="block text-xs text-muted-foreground">
                          {formatMoney(l.unit_price)} · {l.source_kind.replace('_', ' ')}
                          {l.min_qty_applied > 1 && ` · tier ≥${l.min_qty_applied}`}
                        </span>
                      </span>
                      <span className="whitespace-nowrap">{formatMoney(l.line_total)}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex justify-between border-t pt-2 font-medium">
                  <span>Total</span>
                  <span>{formatMoney(quote.data.total)}</span>
                </div>
              </>
            )}

            {insufficient ? (
              <p className="text-sm text-destructive" role="alert">
                Not enough {insufficient.sku}: asked {insufficient.requested}, {insufficient.available} available.
              </p>
            ) : (
              create.isError && <ErrorText error={create.error} />
            )}
            <Button type="submit" disabled={!warehouseId || validItems.length === 0 || duplicate || create.isPending}>
              {create.isPending ? 'Placing…' : 'Place order'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Stock is held for your order until it is paid, cancelled or the hold runs out.
            </p>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
