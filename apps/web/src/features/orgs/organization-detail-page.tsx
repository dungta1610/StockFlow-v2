import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { ErrorState, LoadingRows } from '@/components/page-state';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import { formatDateTime } from '@/lib/format';
import { useOrganization } from './orgs-api';

export function OrganizationDetailPage() {
  const { orgId } = useParams({ from: '/authed/organizations/$orgId' });
  const org = useOrganization(orgId);

  return (
    <div className="flex flex-col gap-4">
      <Link to="/organizations" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Organisations
      </Link>
      {org.isPending ? (
        <Card>
          <LoadingRows rows={6} />
        </Card>
      ) : org.isError ? (
        <Card>
          <ErrorState error={org.error} onRetry={() => void org.refetch()} />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-xl font-semibold">{org.data.code}</h1>
            <Badge tone={org.data.is_active ? 'green' : 'neutral'}>{org.data.is_active ? 'active' : 'inactive'}</Badge>
          </div>
          <Card className="max-w-lg">
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Name</dt>
                <dd>{org.data.name}</dd>
                <dt className="text-muted-foreground">Type</dt>
                <dd>{org.data.type}</dd>
                <dt className="text-muted-foreground">Tax code</dt>
                <dd>{org.data.tax_code ?? '—'}</dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>{formatDateTime(org.data.created_at)}</dd>
              </dl>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
