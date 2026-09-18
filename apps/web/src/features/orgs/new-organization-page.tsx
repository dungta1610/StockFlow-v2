import type { OrgTypeValue } from '@stockflow/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { ErrorText } from '@/components/page-state';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui/primitives';
import { useCreateOrganization } from './orgs-api';

export function NewOrganizationPage() {
  const navigate = useNavigate();
  const create = useCreateOrganization();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<OrgTypeValue>('buyer');
  const [taxCode, setTaxCode] = useState('');

  return (
    <div className="flex flex-col gap-4">
      <Link to="/organizations" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Organisations
      </Link>
      <h1 className="text-xl font-semibold">New organisation</h1>

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
                { code: code.trim(), name: name.trim(), type, tax_code: taxCode.trim() || undefined },
                { onSuccess: (org) => void navigate({ to: '/organizations/$orgId', params: { orgId: org.id } }) },
              );
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="no-code">Code</Label>
              <Input id="no-code" value={code} onChange={(e) => setCode(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="no-name">Name</Label>
              <Input id="no-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="no-type">Type</Label>
              <Select id="no-type" value={type} onChange={(e) => setType(e.target.value as OrgTypeValue)}>
                <option value="buyer">Buyer</option>
                <option value="internal">Internal</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="no-tax">Tax code (optional)</Label>
              <Input id="no-tax" value={taxCode} onChange={(e) => setTaxCode(e.target.value)} />
            </div>
            {create.isError && <ErrorText error={create.error} />}
            <Button type="submit" disabled={create.isPending} className="self-start">
              {create.isPending ? 'Creating…' : 'Create organisation'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
