import type { WarehouseView } from '@stockflow/contracts';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { ErrorState, ErrorText, LoadingRows } from '@/components/page-state';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@/components/ui/primitives';
import { formatDateTime } from '@/lib/format';
import { isOpsAdmin, useRequiredSession } from '../auth/session';
import { useUpdateWarehouse, useWarehouse } from './catalog-api';

export function WarehouseDetailPage() {
  const { warehouseId } = useParams({ from: '/authed/catalog/warehouses/$warehouseId' });
  const session = useRequiredSession();
  const warehouse = useWarehouse(warehouseId);

  return (
    <div className="flex flex-col gap-4">
      <Link to="/catalog/warehouses" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Warehouses
      </Link>
      {warehouse.isPending ? (
        <Card>
          <LoadingRows rows={6} />
        </Card>
      ) : warehouse.isError ? (
        <Card>
          <ErrorState error={warehouse.error} onRetry={() => void warehouse.refetch()} />
        </Card>
      ) : (
        <WarehouseDetail warehouse={warehouse.data} canWrite={isOpsAdmin(session)} />
      )}
    </div>
  );
}

function WarehouseDetail({ warehouse, canWrite }: { warehouse: WarehouseView; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-xl font-semibold">{warehouse.code}</h1>
        <Badge tone={warehouse.is_active ? 'green' : 'neutral'}>{warehouse.is_active ? 'active' : 'inactive'}</Badge>
      </div>

      <Card className="max-w-lg">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{editing ? 'Edit warehouse' : 'Details'}</CardTitle>
          {canWrite && !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {editing ? (
            <WarehouseForm warehouse={warehouse} onDone={() => setEditing(false)} />
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{warehouse.name}</dd>
              <dt className="text-muted-foreground">Address</dt>
              <dd>{warehouse.address || '—'}</dd>
              <dt className="text-muted-foreground">Updated</dt>
              <dd>{formatDateTime(warehouse.updated_at)}</dd>
            </dl>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function WarehouseForm({ warehouse, onDone }: { warehouse: WarehouseView; onDone: () => void }) {
  const update = useUpdateWarehouse(warehouse.id);
  const [name, setName] = useState(warehouse.name);
  const [address, setAddress] = useState(warehouse.address);
  const [isActive, setIsActive] = useState(warehouse.is_active);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate({ name: name.trim(), address: address.trim(), is_active: isActive }, { onSuccess: onDone });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="w-name">Name</Label>
        <Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="w-address">Address</Label>
        <Input id="w-address" value={address} onChange={(e) => setAddress(e.target.value)} />
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
