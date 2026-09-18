import type { RoleValue } from '@stockflow/contracts';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingRows } from '@/components/page-state';
import { Badge, Button, Card, Input, Select, Table, Td, Th } from '@/components/ui/primitives';
import { useOrganizations } from '../orgs/orgs-api';
import { useUserList } from './users-api';

export interface UsersSearch {
  page?: number;
  email?: string;
  role?: RoleValue;
  is_active?: boolean;
}

const ROLES: RoleValue[] = ['buyer', 'buyer_admin', 'ops', 'ops_admin'];

export function validateUsersSearch(raw: Record<string, unknown>): UsersSearch {
  const page = Number(raw.page);
  const role = ROLES.includes(raw.role as RoleValue) ? (raw.role as RoleValue) : undefined;
  return {
    page: Number.isInteger(page) && page > 1 ? page : undefined,
    email: typeof raw.email === 'string' && raw.email ? raw.email : undefined,
    role,
    is_active: raw.is_active === 'true' ? true : raw.is_active === 'false' ? false : undefined,
  };
}

export function UsersListPage() {
  const search = useSearch({ from: '/authed/users' });
  const navigate = useNavigate({ from: '/users' });
  const [email, setEmail] = useState(search.email ?? '');
  const page = search.page ?? 1;
  const users = useUserList({ ...search, page });
  const orgs = useOrganizations();
  const orgLabel = (id: string) => orgs.data?.find((o) => o.id === id)?.code ?? id.slice(0, 8);

  const setFilter = (patch: UsersSearch) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: patch.page && patch.page > 1 ? patch.page : undefined }) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">Accounts and their organisation role.</p>
        </div>
        <Link to="/users/new">
          <Button>
            <Plus className="size-4" /> New user
          </Button>
        </Link>
      </div>

      <Card>
        <form
          className="grid gap-3 border-b p-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ email: email.trim() || undefined });
          }}
        >
          <Input placeholder="Exact email" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Select value={search.role ?? ''} onChange={(e) => setFilter({ role: (e.target.value || undefined) as RoleValue | undefined })} aria-label="Role">
            <option value="">Every role</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
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

        {users.isPending ? (
          <LoadingRows />
        ) : users.isError ? (
          <ErrorState error={users.error} onRetry={() => void users.refetch()} />
        ) : users.data.data.length === 0 ? (
          <EmptyState title="No users match" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Email</Th>
                <Th>Full name</Th>
                <Th>Organisation</Th>
                <Th>Role</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {users.data.data.map((u) => (
                <tr key={u.id} className="hover:bg-muted/50">
                  <Td>
                    <Link to="/users/$userId" params={{ userId: u.id }} className="underline-offset-2 hover:underline">
                      {u.email}
                    </Link>
                  </Td>
                  <Td>{u.full_name}</Td>
                  <Td className="whitespace-nowrap">{u.memberships.map((m) => orgLabel(m.org_id)).join(', ') || '—'}</Td>
                  <Td className="whitespace-nowrap">{u.memberships.map((m) => m.role).join(', ') || '—'}</Td>
                  <Td>
                    <Badge tone={u.is_active ? 'green' : 'neutral'}>{u.is_active ? 'active' : 'inactive'}</Badge>
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
            <Button variant="outline" size="sm" disabled={(users.data?.data.length ?? 0) < 20} onClick={() => setFilter({ page: page + 1 })}>
              Next
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
