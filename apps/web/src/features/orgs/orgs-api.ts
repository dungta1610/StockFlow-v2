import type { CreateOrganizationRequest, OrgTypeValue, OrganizationView, PagingMeta } from '@stockflow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

// Organisations (StockFlow /organizations). Reads are scoped server-side (a buyer
// sees only their own organisation); creation is ops_admin only. There is no update
// endpoint yet — see the phase report for that gap.

export interface OrganizationListFilter {
  page: number;
  code?: string;
  type?: OrgTypeValue;
}

export const orgKeys = {
  list: (f: OrganizationListFilter) => ['organizations', 'list', f] as const,
  detail: (id: string) => ['organizations', 'detail', id] as const,
};

/** Every organisation in the caller's scope, unpaged: used by filters and forms. */
export function useOrganizations() {
  return useQuery({
    queryKey: ['organizations', 'all'],
    queryFn: () => api<{ data: OrganizationView[] }>('/organizations', { query: { limit: 100 } }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useOrganizationList(filter: OrganizationListFilter) {
  return useQuery({
    queryKey: orgKeys.list(filter),
    queryFn: () => api<{ data: OrganizationView[]; paging: PagingMeta }>('/organizations', { query: { ...filter, limit: 20 } }),
  });
}

export function useOrganization(id: string) {
  return useQuery({
    queryKey: orgKeys.detail(id),
    queryFn: () => api<{ data: OrganizationView }>(`/organizations/${id}`).then((r) => r.data),
  });
}

export function useCreateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateOrganizationRequest) =>
      api<{ data: OrganizationView }>('/organizations', { method: 'POST', body }).then((r) => r.data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['organizations'] }),
  });
}
