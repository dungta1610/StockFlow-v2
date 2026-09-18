import type { RoleValue, UserView } from '@stockflow/contracts';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { ErrorState, ErrorText, LoadingRows } from '@/components/page-state';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui/primitives';
import { formatDateTime } from '@/lib/format';
import { rolesForOrgType, useUpdateUser, useUser } from './users-api';

export function UserDetailPage() {
  const { userId } = useParams({ from: '/authed/users/$userId' });
  const user = useUser(userId);

  return (
    <div className="flex flex-col gap-4">
      <Link to="/users" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Users
      </Link>
      {user.isPending ? (
        <Card>
          <LoadingRows rows={6} />
        </Card>
      ) : user.isError ? (
        <Card>
          <ErrorState error={user.error} onRetry={() => void user.refetch()} />
        </Card>
      ) : (
        <UserDetail user={user.data} />
      )}
    </div>
  );
}

function UserDetail({ user }: { user: UserView }) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{user.full_name}</h1>
        <Badge tone={user.is_active ? 'green' : 'neutral'}>{user.is_active ? 'active' : 'inactive'}</Badge>
      </div>

      <Card className="max-w-lg">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{editing ? 'Edit user' : 'Details'}</CardTitle>
          {!editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {editing ? (
            <UserForm user={user} onDone={() => setEditing(false)} />
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Email</dt>
              <dd>{user.email}</dd>
              <dt className="text-muted-foreground">Memberships</dt>
              <dd>
                {user.memberships.map((m) => (
                  <div key={m.org_id}>
                    {m.org_code} · {m.role}
                  </div>
                ))}
              </dd>
              <dt className="text-muted-foreground">Updated</dt>
              <dd>{formatDateTime(user.updated_at)}</dd>
            </dl>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function UserForm({ user, onDone }: { user: UserView; onDone: () => void }) {
  const update = useUpdateUser(user.id);
  const [orgId, setOrgId] = useState(user.memberships[0]?.org_id ?? '');
  const membership = user.memberships.find((m) => m.org_id === orgId) ?? user.memberships[0];
  const [fullName, setFullName] = useState(user.full_name);
  const [role, setRole] = useState<RoleValue>(membership?.role ?? 'buyer');
  const [password, setPassword] = useState('');
  const [isActive, setIsActive] = useState(user.is_active);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate(
          {
            full_name: fullName.trim(),
            role,
            password: password || undefined,
            // Sent only when changed: the API treats is_active as an account-wide change and
            // refuses it for a user who also belongs to an org outside this admin's scope.
            is_active: isActive !== user.is_active ? isActive : undefined,
            org_id: user.memberships.length > 1 ? orgId : undefined,
          },
          { onSuccess: onDone },
        );
      }}
    >
      {user.memberships.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="u-org">Organisation (which membership to change)</Label>
          <Select
            id="u-org"
            value={orgId}
            onChange={(e) => {
              setOrgId(e.target.value);
              const next = user.memberships.find((m) => m.org_id === e.target.value);
              if (next) setRole(next.role);
            }}
          >
            {user.memberships.map((m) => (
              <option key={m.org_id} value={m.org_id}>
                {m.org_code} · {m.role}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="u-name">Full name</Label>
        <Input id="u-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="u-role">Role</Label>
        <Select id="u-role" value={role} onChange={(e) => setRole(e.target.value as RoleValue)}>
          {(membership ? rolesForOrgType(membership.org_type) : []).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="u-password">New password (optional)</Label>
        <Input id="u-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Leave blank to keep it" />
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
