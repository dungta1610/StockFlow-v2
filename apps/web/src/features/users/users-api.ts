import type { CreateUserRequest, OrgTypeValue, PagingMeta, RoleValue, UpdateUserRequest, UserView } from '@stockflow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

// Users (StockFlow /users). Only ops_admin and buyer_admin may call these routes at
// all (the controller requires one of those roles); the API scopes a buyer_admin to
// their own organisation.

/**
 * Which roles an organisation type may hold — mirrors the API's
 * `ROLES_BY_ORG_TYPE` (identity/domain/role.ts) so the form only offers choices the
 * server will accept. UI convenience only: the server re-checks this itself.
 */
const ROLES_BY_ORG_TYPE: Record<OrgTypeValue, RoleValue[]> = {
  internal: ['ops', 'ops_admin'],
  buyer: ['buyer', 'buyer_admin'],
};

export const rolesForOrgType = (type: OrgTypeValue): RoleValue[] => ROLES_BY_ORG_TYPE[type];

export interface UserListFilter {
  page: number;
  email?: string;
  full_name?: string;
  role?: RoleValue;
  is_active?: boolean;
  org_id?: string;
}

export const userKeys = {
  list: (f: UserListFilter) => ['users', 'list', f] as const,
  detail: (id: string) => ['users', 'detail', id] as const,
};

export function useUserList(filter: UserListFilter) {
  return useQuery({
    queryKey: userKeys.list(filter),
    queryFn: () => api<{ data: UserView[]; paging: PagingMeta }>('/users', { query: { ...filter, limit: 20 } }),
  });
}

export function useUser(id: string) {
  return useQuery({
    queryKey: userKeys.detail(id),
    queryFn: () => api<{ data: UserView }>(`/users/${id}`).then((r) => r.data),
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserRequest) => api<{ data: UserView }>('/users', { method: 'POST', body }).then((r) => r.data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useUpdateUser(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateUserRequest) => api<{ data: UserView }>(`/users/${id}`, { method: 'PUT', body }).then((r) => r.data),
    onSuccess: (user) => {
      qc.setQueryData(userKeys.detail(id), user);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}
