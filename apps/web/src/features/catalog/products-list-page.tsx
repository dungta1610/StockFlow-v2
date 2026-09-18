import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingRows } from '@/components/page-state';
import { Badge, Button, Card, Input, Select, Table, Td, Th } from '@/components/ui/primitives';
import { formatMoney } from '@/lib/format';
import { isOpsAdmin, useRequiredSession } from '../auth/session';
import { useProductList } from './catalog-api';

export interface ProductsSearch {
  page?: number;
  sku?: string;
  name?: string;
  is_active?: boolean;
}

export function validateProductsSearch(raw: Record<string, unknown>): ProductsSearch {
  const page = Number(raw.page);
  return {
    page: Number.isInteger(page) && page > 1 ? page : undefined,
    sku: typeof raw.sku === 'string' && raw.sku ? raw.sku : undefined,
    name: typeof raw.name === 'string' && raw.name ? raw.name : undefined,
    is_active: raw.is_active === 'true' ? true : raw.is_active === 'false' ? false : undefined,
  };
}

export function ProductsListPage() {
  const session = useRequiredSession();
  const canWrite = isOpsAdmin(session);
  const search = useSearch({ from: '/authed/catalog/products' });
  const navigate = useNavigate({ from: '/catalog/products' });
  const [name, setName] = useState(search.name ?? '');
  const page = search.page ?? 1;
  const products = useProductList({ ...search, page });

  const setFilter = (patch: ProductsSearch) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: patch.page && patch.page > 1 ? patch.page : undefined }) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Products</h1>
          <p className="text-sm text-muted-foreground">Catalog and list prices.</p>
        </div>
        {canWrite && (
          <Link to="/catalog/products/new">
            <Button>
              <Plus className="size-4" /> New product
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

        {products.isPending ? (
          <LoadingRows />
        ) : products.isError ? (
          <ErrorState error={products.error} onRetry={() => void products.refetch()} />
        ) : products.data.data.length === 0 ? (
          <EmptyState title="No products match" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>SKU</Th>
                <Th>Name</Th>
                <Th className="text-right">Base price</Th>
                <Th>UoM</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {products.data.data.map((p) => (
                <tr key={p.id} className="hover:bg-muted/50">
                  <Td>
                    <Link
                      to="/catalog/products/$productId"
                      params={{ productId: p.id }}
                      className="font-mono text-xs whitespace-nowrap underline-offset-2 hover:underline"
                    >
                      {p.sku}
                    </Link>
                  </Td>
                  <Td>{p.name}</Td>
                  <Td className="text-right whitespace-nowrap">{formatMoney(p.base_price)}</Td>
                  <Td>{p.uom}</Td>
                  <Td>
                    <Badge tone={p.is_active ? 'green' : 'neutral'}>{p.is_active ? 'active' : 'inactive'}</Badge>
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
              disabled={(products.data?.data.length ?? 0) < 20}
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
