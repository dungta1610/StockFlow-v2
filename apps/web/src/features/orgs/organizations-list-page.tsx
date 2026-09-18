import type { OrgTypeValue } from '@stockflow/contracts';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingRows } from '@/components/page-state';
import { Badge, Button, Card, Input, Select, Table, Td, Th } from '@/components/ui/primitives';
import { formatDateTime } from '@/lib/format';
import { isOpsAdmin, useRequiredSession } from '../auth/session';
import { useOrganizationList } from './orgs-api';

export interface OrganizationsSearch {
  page?: number;
  code?: string;
  type?: OrgTypeValue;
}

export function validateOrganizationsSearch(raw: Record<string, unknown>): OrganizationsSearch {
  const page = Number(raw.page);
  const type = raw.type === 'buyer' || raw.type === 'internal' ? raw.type : undefined;
  return {
    page: Number.isInteger(page) && page > 1 ? page : undefined,
    code: typeof raw.code === 'string' && raw.code ? raw.code : undefined,
    type,
  };
}

export function OrganizationsListPage() {
  const session = useRequiredSession();
  const canWrite = isOpsAdmin(session);
  const search = useSearch({ from: '/authed/organizations' });
  const navigate = useNavigate({ from: '/organizations' });
  const [code, setCode] = useState(search.code ?? '');
  const page = search.page ?? 1;
  const orgs = useOrganizationList({ ...search, page });

  const setFilter = (patch: OrganizationsSearch) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: patch.page && patch.page > 1 ? patch.page : undefined }) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Organisations</h1>
          <p className="text-sm text-muted-foreground">Buyers you sell to, and StockFlow's own internal organisation.</p>
        </div>
        {canWrite && (
          <Link to="/organizations/new">
            <Button>
              <Plus className="size-4" /> New organisation
            </Button>
          </Link>
        )}
      </div>

      <Card>
        <form
          className="grid gap-3 border-b p-3 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ code: code.trim() || undefined });
          }}
        >
          <Input placeholder="Code, e.g. ACME" value={code} onChange={(e) => setCode(e.target.value)} />
          <Select
            value={search.type ?? ''}
            onChange={(e) => setFilter({ type: (e.target.value || undefined) as OrgTypeValue | undefined })}
            aria-label="Type"
          >
            <option value="">Every type</option>
            <option value="buyer">Buyer</option>
            <option value="internal">Internal</option>
          </Select>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>

        {orgs.isPending ? (
          <LoadingRows />
        ) : orgs.isError ? (
          <ErrorState error={orgs.error} onRetry={() => void orgs.refetch()} />
        ) : orgs.data.data.length === 0 ? (
          <EmptyState title="No organisations match" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {orgs.data.data.map((o) => (
                <tr key={o.id} className="hover:bg-muted/50">
                  <Td>
                    <Link to="/organizations/$orgId" params={{ orgId: o.id }} className="font-mono text-xs underline-offset-2 hover:underline">
                      {o.code}
                    </Link>
                  </Td>
                  <Td>{o.name}</Td>
                  <Td>{o.type}</Td>
                  <Td>
                    <Badge tone={o.is_active ? 'green' : 'neutral'}>{o.is_active ? 'active' : 'inactive'}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap">{formatDateTime(o.created_at)}</Td>
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
            <Button variant="outline" size="sm" disabled={(orgs.data?.data.length ?? 0) < 20} onClick={() => setFilter({ page: page + 1 })}>
              Next
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
