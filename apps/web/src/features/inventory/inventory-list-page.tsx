import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { EmptyState, ErrorState, LoadingRows } from '@/components/page-state';
import { Button, Card, Select, Table, Td, Th } from '@/components/ui/primitives';
import { formatDateTime } from '@/lib/format';
import { useActiveProducts, useActiveWarehouses } from '../catalog/catalog-api';
import { useInventoryList } from './inventory-api';

export interface InventorySearch {
  page?: number;
  product_id?: string;
  warehouse_id?: string;
}

export function validateInventorySearch(raw: Record<string, unknown>): InventorySearch {
  const page = Number(raw.page);
  return {
    page: Number.isInteger(page) && page > 1 ? page : undefined,
    product_id: typeof raw.product_id === 'string' && raw.product_id ? raw.product_id : undefined,
    warehouse_id: typeof raw.warehouse_id === 'string' && raw.warehouse_id ? raw.warehouse_id : undefined,
  };
}

export function InventoryListPage() {
  const search = useSearch({ from: '/authed/inventory' });
  const navigate = useNavigate({ from: '/inventory' });
  const page = search.page ?? 1;
  const inventory = useInventoryList({ ...search, page });
  const products = useActiveProducts();
  const warehouses = useActiveWarehouses();

  const setFilter = (patch: InventorySearch) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: patch.page && patch.page > 1 ? patch.page : undefined }) });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Inventory</h1>
        <p className="text-sm text-muted-foreground">Stock levels across every warehouse, from the append-only ledger.</p>
      </div>

      <Card>
        <div className="grid gap-3 border-b p-3 sm:grid-cols-2">
          <Select
            aria-label="Product"
            value={search.product_id ?? ''}
            onChange={(e) => setFilter({ product_id: e.target.value || undefined })}
          >
            <option value="">All products</option>
            {products.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} — {p.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Warehouse"
            value={search.warehouse_id ?? ''}
            onChange={(e) => setFilter({ warehouse_id: e.target.value || undefined })}
          >
            <option value="">All warehouses</option>
            {warehouses.data?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} — {w.name}
              </option>
            ))}
          </Select>
        </div>

        {inventory.isPending ? (
          <LoadingRows />
        ) : inventory.isError ? (
          <ErrorState error={inventory.error} onRetry={() => void inventory.refetch()} />
        ) : inventory.data.data.length === 0 ? (
          <EmptyState title="No stock records match">Adjust the filters, or none has been recorded yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>SKU</Th>
                <Th>Warehouse</Th>
                <Th className="text-right">Available</Th>
                <Th className="text-right">Reserved</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {inventory.data.data.map((i) => (
                <tr key={i.id} className="hover:bg-muted/50">
                  <Td>
                    <Link
                      to="/inventory/$inventoryId"
                      params={{ inventoryId: i.id }}
                      className="font-mono text-xs whitespace-nowrap underline-offset-2 hover:underline"
                    >
                      {i.sku}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap">{i.warehouse_code}</Td>
                  <Td className="text-right">{i.available_qty}</Td>
                  <Td className="text-right">{i.reserved_qty}</Td>
                  <Td className="whitespace-nowrap">{formatDateTime(i.updated_at)}</Td>
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
              disabled={(inventory.data?.data.length ?? 0) < 20}
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
