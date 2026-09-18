import type { PriceListStatusValue } from '@stockflow/contracts';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { EmptyState, ErrorState, LoadingRows } from '@/components/page-state';
import { Badge, Button, Card, Select, Table, Td, Th } from '@/components/ui/primitives';
import { formatDateTime } from '@/lib/format';
import { isOpsAdmin, useRequiredSession } from '../auth/session';
import { useOrganizations } from '../orgs/orgs-api';
import { usePriceLists } from './pricing-api';

export interface PriceListsSearch {
  page?: number;
  org_id?: string;
  status?: PriceListStatusValue;
}

export function validatePriceListsSearch(raw: Record<string, unknown>): PriceListsSearch {
  const page = Number(raw.page);
  const status = raw.status === 'active' || raw.status === 'archived' ? raw.status : undefined;
  return {
    page: Number.isInteger(page) && page > 1 ? page : undefined,
    org_id: typeof raw.org_id === 'string' && raw.org_id ? raw.org_id : undefined,
    status,
  };
}

export function PriceListsListPage() {
  const session = useRequiredSession();
  const canWrite = isOpsAdmin(session);
  const search = useSearch({ from: '/authed/price-lists' });
  const navigate = useNavigate({ from: '/price-lists' });
  const page = search.page ?? 1;
  const priceLists = usePriceLists({ ...search, page });
  const orgs = useOrganizations();
  const orgLabel = (id: string | null) => (id ? (orgs.data?.find((o) => o.id === id)?.code ?? id.slice(0, 8)) : 'Default (all buyers)');

  const setFilter = (patch: PriceListsSearch) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: patch.page && patch.page > 1 ? patch.page : undefined }) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Price lists</h1>
          <p className="text-sm text-muted-foreground">Contract prices per buyer, plus the default list. Buyers see prices only through quotes.</p>
        </div>
        {canWrite && (
          <Link to="/price-lists/new">
            <Button>
              <Plus className="size-4" /> New price list
            </Button>
          </Link>
        )}
      </div>

      <Card>
        <div className="grid gap-3 border-b p-3 sm:grid-cols-2">
          <Select
            aria-label="Organisation"
            value={search.org_id ?? ''}
            onChange={(e) => setFilter({ org_id: e.target.value || undefined })}
          >
            <option value="">All organisations</option>
            {orgs.data
              ?.filter((o) => o.type === 'buyer')
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.code} — {o.name}
                </option>
              ))}
          </Select>
          <Select
            aria-label="Status"
            value={search.status ?? ''}
            onChange={(e) => setFilter({ status: (e.target.value || undefined) as PriceListStatusValue | undefined })}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </Select>
        </div>

        {priceLists.isPending ? (
          <LoadingRows />
        ) : priceLists.isError ? (
          <ErrorState error={priceLists.error} onRetry={() => void priceLists.refetch()} />
        ) : priceLists.data.data.length === 0 ? (
          <EmptyState title="No price lists match" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Organisation</Th>
                <Th className="text-right">Priority</Th>
                <Th>Valid from</Th>
                <Th>Valid to</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {priceLists.data.data.map((l) => (
                <tr key={l.id} className="hover:bg-muted/50">
                  <Td>
                    <Link to="/price-lists/$priceListId" params={{ priceListId: l.id }} className="underline-offset-2 hover:underline">
                      {l.name}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap">{orgLabel(l.org_id)}</Td>
                  <Td className="text-right">{l.priority}</Td>
                  <Td className="whitespace-nowrap">{formatDateTime(l.valid_from)}</Td>
                  <Td className="whitespace-nowrap">{l.valid_to ? formatDateTime(l.valid_to) : 'No end date'}</Td>
                  <Td>
                    <Badge tone={l.status === 'active' ? 'green' : 'neutral'}>{l.status}</Badge>
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
              disabled={(priceLists.data?.data.length ?? 0) < 20}
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
