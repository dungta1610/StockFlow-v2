import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { ErrorText } from '@/components/page-state';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui/primitives';
import { useOrganizations } from '../orgs/orgs-api';
import { useCreatePriceList } from './pricing-api';

export function NewPriceListPage() {
  const navigate = useNavigate();
  const orgs = useOrganizations();
  const create = useCreatePriceList();
  const [orgId, setOrgId] = useState('');
  const [name, setName] = useState('');
  const [validFrom, setValidFrom] = useState(() => toLocalInput(new Date()));
  const [validTo, setValidTo] = useState('');
  const [priority, setPriority] = useState('0');

  return (
    <div className="flex flex-col gap-4">
      <Link to="/price-lists" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Price lists
      </Link>
      <h1 className="text-xl font-semibold">New price list</h1>

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
                {
                  org_id: orgId || null,
                  name: name.trim(),
                  valid_from: new Date(validFrom).toISOString(),
                  valid_to: validTo ? new Date(validTo).toISOString() : null,
                  priority: Number(priority),
                },
                { onSuccess: (list) => void navigate({ to: '/price-lists/$priceListId', params: { priceListId: list.id } }) },
              );
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pl-org">Organisation</Label>
              <Select id="pl-org" value={orgId} onChange={(e) => setOrgId(e.target.value)} disabled={orgs.isPending}>
                <option value="">Default (all buyers)</option>
                {orgs.data
                  ?.filter((o) => o.type === 'buyer')
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.code} — {o.name}
                    </option>
                  ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pl-name">Name</Label>
              <Input id="pl-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pl-from">Valid from</Label>
              <Input id="pl-from" type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pl-to">Valid to (optional)</Label>
              <Input id="pl-to" type="datetime-local" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pl-priority">Priority</Label>
              <Input id="pl-priority" type="number" step={1} value={priority} onChange={(e) => setPriority(e.target.value)} />
              <p className="text-xs text-muted-foreground">Higher wins among lists of the same kind (default vs. this organisation's).</p>
            </div>
            {create.isError && <ErrorText error={create.error} />}
            <Button type="submit" disabled={create.isPending} className="self-start">
              {create.isPending ? 'Creating…' : 'Create price list'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/** `Date` → the value a `datetime-local` input expects, in the browser's local time. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
