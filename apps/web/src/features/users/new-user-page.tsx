import type { RoleValue } from '@stockflow/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ErrorState, ErrorText, LoadingRows } from '@/components/page-state';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui/primitives';
import { useOrganizations } from '../orgs/orgs-api';
import { rolesForOrgType, useCreateUser } from './users-api';

export function NewUserPage() {
  const navigate = useNavigate();
  const orgs = useOrganizations();
  const create = useCreateUser();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [role, setRole] = useState<RoleValue | ''>('');

  const org = orgs.data?.find((o) => o.id === orgId);
  const roleOptions = useMemo(() => (org ? rolesForOrgType(org.type) : []), [org]);

  return (
    <div className="flex flex-col gap-4">
      <Link to="/users" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Users
      </Link>
      <h1 className="text-xl font-semibold">New user</h1>

      {orgs.isPending ? (
        <Card>
          <LoadingRows rows={4} />
        </Card>
      ) : orgs.isError ? (
        <Card>
          <ErrorState error={orgs.error} onRetry={() => void orgs.refetch()} />
        </Card>
      ) : (
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!orgId || !role) return;
                create.mutate(
                  { email: email.trim(), password, full_name: fullName.trim(), org_id: orgId, role },
                  { onSuccess: (user) => void navigate({ to: '/users/$userId', params: { userId: user.id } }) },
                );
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nu-email">Email</Label>
                <Input id="nu-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nu-password">Password</Label>
                <Input id="nu-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nu-name">Full name</Label>
                <Input id="nu-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nu-org">Organisation</Label>
                <Select
                  id="nu-org"
                  value={orgId}
                  onChange={(e) => {
                    setOrgId(e.target.value);
                    setRole('');
                  }}
                  required
                >
                  <option value="">Choose an organisation</option>
                  {orgs.data.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.code} — {o.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nu-role">Role</Label>
                <Select id="nu-role" value={role} onChange={(e) => setRole(e.target.value as RoleValue)} disabled={!org} required>
                  <option value="">{org ? 'Choose a role' : 'Choose an organisation first'}</option>
                  {roleOptions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </div>
              {create.isError && <ErrorText error={create.error} />}
              <Button type="submit" disabled={create.isPending || !orgId || !role} className="self-start">
                {create.isPending ? 'Creating…' : 'Create user'}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
