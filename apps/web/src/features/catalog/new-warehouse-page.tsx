import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { ErrorText } from '@/components/page-state';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@/components/ui/primitives';
import { useCreateWarehouse } from './catalog-api';

export function NewWarehousePage() {
  const navigate = useNavigate();
  const create = useCreateWarehouse();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');

  return (
    <div className="flex flex-col gap-4">
      <Link to="/catalog/warehouses" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Warehouses
      </Link>
      <h1 className="text-xl font-semibold">New warehouse</h1>

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
                { code: code.trim(), name: name.trim(), address: address.trim() },
                { onSuccess: (warehouse) => void navigate({ to: '/catalog/warehouses/$warehouseId', params: { warehouseId: warehouse.id } }) },
              );
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nw-code">Code</Label>
              <Input id="nw-code" value={code} onChange={(e) => setCode(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nw-name">Name</Label>
              <Input id="nw-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nw-address">Address</Label>
              <Input id="nw-address" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
            {create.isError && <ErrorText error={create.error} />}
            <Button type="submit" disabled={create.isPending} className="self-start">
              {create.isPending ? 'Creating…' : 'Create warehouse'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
