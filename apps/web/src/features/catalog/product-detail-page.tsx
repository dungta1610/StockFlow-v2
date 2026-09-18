import type { ProductView } from '@stockflow/contracts';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { ErrorState, ErrorText, LoadingRows } from '@/components/page-state';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@/components/ui/primitives';
import { formatDateTime, formatMoney } from '@/lib/format';
import { isOpsAdmin, useRequiredSession } from '../auth/session';
import { useProduct, useUpdateProduct } from './catalog-api';

export function ProductDetailPage() {
  const { productId } = useParams({ from: '/authed/catalog/products/$productId' });
  const session = useRequiredSession();
  const product = useProduct(productId);

  return (
    <div className="flex flex-col gap-4">
      <Link to="/catalog/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Products
      </Link>
      {product.isPending ? (
        <Card>
          <LoadingRows rows={6} />
        </Card>
      ) : product.isError ? (
        <Card>
          <ErrorState error={product.error} onRetry={() => void product.refetch()} />
        </Card>
      ) : (
        <ProductDetail product={product.data} canWrite={isOpsAdmin(session)} />
      )}
    </div>
  );
}

function ProductDetail({ product, canWrite }: { product: ProductView; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-xl font-semibold">{product.sku}</h1>
        <Badge tone={product.is_active ? 'green' : 'neutral'}>{product.is_active ? 'active' : 'inactive'}</Badge>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{editing ? 'Edit product' : 'Details'}</CardTitle>
          {canWrite && !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {editing ? (
            <ProductForm product={product} onDone={() => setEditing(false)} />
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{product.name}</dd>
              <dt className="text-muted-foreground">Description</dt>
              <dd>{product.description || '—'}</dd>
              <dt className="text-muted-foreground">Base price</dt>
              <dd className="font-medium">{formatMoney(product.base_price)}</dd>
              <dt className="text-muted-foreground">Unit of measure</dt>
              <dd>{product.uom}</dd>
              <dt className="text-muted-foreground">Updated</dt>
              <dd>{formatDateTime(product.updated_at)}</dd>
            </dl>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function ProductForm({ product, onDone }: { product: ProductView; onDone: () => void }) {
  const update = useUpdateProduct(product.id);
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description);
  const [basePrice, setBasePrice] = useState(product.base_price);
  const [isActive, setIsActive] = useState(product.is_active);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate(
          { name: name.trim(), description: description.trim(), base_price: basePrice.trim(), is_active: isActive },
          { onSuccess: onDone },
        );
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="p-name">Name</Label>
        <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="p-desc">Description</Label>
        <Input id="p-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="p-price">Base price (VND)</Label>
        <Input id="p-price" inputMode="decimal" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} required />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active
      </label>
      {update.isError && <ErrorText error={update.error} />}
      <div className="flex gap-2">
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
