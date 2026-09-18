import type { AuditLogView, PagingMeta } from '@stockflow/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

// GET /ops/audit (StockFlow): ops_admin only, so callers must gate on isOpsAdmin
// before enabling this query — the API returns 403 for everyone else.

export interface AuditLogFilter {
  aggregate_type: string;
  aggregate_id: string;
}

export function useAuditLog(filter: AuditLogFilter, enabled: boolean) {
  return useQuery({
    queryKey: ['audit', 'list', filter],
    queryFn: () =>
      api<{ data: AuditLogView[]; paging: PagingMeta }>('/ops/audit', { query: { ...filter, limit: 50 } }).then((r) => r.data),
    enabled,
  });
}
