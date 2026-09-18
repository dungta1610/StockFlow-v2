import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { ErrorText } from '@/components/page-state';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@/components/ui/primitives';
import { useCreateProduct } from './catalog-api';

export function NewProductPage() {
  const navigate = useNavigate();
  const create = useCreateProduct();
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [basePrice, setBasePrice] = useState('');
  const [uom, setUom] = useState('each');

  return (
    <div className="flex flex-col gap-4">
      <Link to="/catalog/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Products
      </Link>
      <h1 className="text-xl font-semibold">New product</h1>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(
                { sku: sku.trim(), name: name.trim(), description: description.trim(), base_price: basePrice.trim(), uom: uom.trim() },
                { onSuccess: (product) => void navigate({ to: '/catalog/products/$productId', params: { productId: product.id } }) },
              );
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="np-sku">SKU</Label>
              <Input id="np-sku" value={sku} onChange={(e) => setSku(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="np-name">Name</Label>
              <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="np-desc">Description</Label>
              <Input id="np-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="np-price">Base price (VND)</Label>
              <Input id="np-price" inputMode="decimal" placeholder="e.g. 65000.00" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="np-uom">Unit of measure</Label>
              <Input id="np-uom" value={uom} onChange={(e) => setUom(e.target.value)} required />
            </div>
            {create.isError && <ErrorText error={create.error} />}
            <Button type="submit" disabled={create.isPending} className="self-start">
              {create.isPending ? 'Creating…' : 'Create product'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
