import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingRows } from '@/components/page-state';
import { Badge, Button, Card, Input, Select, Table, Td, Th } from '@/components/ui/primitives';
import { isOpsAdmin, useRequiredSession } from '../auth/session';
import { useWarehouseList } from './catalog-api';

export interface WarehousesSearch {
  page?: number;
  name?: string;
  is_active?: boolean;
}

export function validateWarehousesSearch(raw: Record<string, unknown>): WarehousesSearch {
  const page = Number(raw.page);
  return {
    page: Number.isInteger(page) && page > 1 ? page : undefined,
    name: typeof raw.name === 'string' && raw.name ? raw.name : undefined,
    is_active: raw.is_active === 'true' ? true : raw.is_active === 'false' ? false : undefined,
  };
}

export function WarehousesListPage() {
  const session = useRequiredSession();
  const canWrite = isOpsAdmin(session);
  const search = useSearch({ from: '/authed/catalog/warehouses' });
  const navigate = useNavigate({ from: '/catalog/warehouses' });
  const [name, setName] = useState(search.name ?? '');
  const page = search.page ?? 1;
  const warehouses = useWarehouseList({ ...search, page });

  const setFilter = (patch: WarehousesSearch) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: patch.page && patch.page > 1 ? patch.page : undefined }) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Warehouses</h1>
          <p className="text-sm text-muted-foreground">Where stock is held and orders fulfil from.</p>
        </div>
        {canWrite && (
          <Link to="/catalog/warehouses/new">
            <Button>
              <Plus className="size-4" /> New warehouse
            </Button>
          </Link>
        )}
      </div>

      <Card>
        <form
          className="grid gap-3 border-b p-3 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ name: name.trim() || undefined });
          }}
        >
          <Input placeholder="Name contains…" value={name} onChange={(e) => setName(e.target.value)} />
          <Select
            value={search.is_active === undefined ? '' : String(search.is_active)}
            onChange={(e) => setFilter({ is_active: e.target.value === '' ? undefined : e.target.value === 'true' })}
            aria-label="Active"
          >
            <option value="">Active and inactive</option>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
          </Select>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>

        {warehouses.isPending ? (
          <LoadingRows />
        ) : warehouses.isError ? (
          <ErrorState error={warehouses.error} onRetry={() => void warehouses.refetch()} />
        ) : warehouses.data.data.length === 0 ? (
          <EmptyState title="No warehouses match" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Address</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {warehouses.data.data.map((w) => (
                <tr key={w.id} className="hover:bg-muted/50">
                  <Td>
                    <Link
                      to="/catalog/warehouses/$warehouseId"
                      params={{ warehouseId: w.id }}
                      className="font-mono text-xs whitespace-nowrap underline-offset-2 hover:underline"
                    >
                      {w.code}
                    </Link>
                  </Td>
                  <Td>{w.name}</Td>
                  <Td className="max-w-[20rem] truncate text-muted-foreground">{w.address || '—'}</Td>
                  <Td>
                    <Badge tone={w.is_active ? 'green' : 'neutral'}>{w.is_active ? 'active' : 'inactive'}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <div className="flex items-center justify-between p-3 text-sm">
          <span className="text-muted-foreground">Page {page}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setFilter({ page: page - 1 })}>
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={(warehouses.data?.data.length ?? 0) < 20}
              onClick={() => setFilter({ page: page + 1 })}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
