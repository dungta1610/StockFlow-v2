import type { CreateOrderRequest, InventoryTransactionView, OrderStatusValue, OrderView, PagingMeta } from '@stockflow/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

// Reference data the order screens build from now lives with its own domain
// (features/catalog, features/orgs, features/pricing); re-exported here so the
// order screens' imports do not have to change.
export { useActiveWarehouses as useWarehouses, useActiveProducts as useProducts } from '../catalog/catalog-api';
export { useOrganizations } from '../orgs/orgs-api';
export { useQuote } from '../pricing/pricing-api';

export interface OrderListFilter {
  page: number;
  status?: OrderStatusValue;
  order_code?: string;
  buyer_org_id?: string;
}

export type OrderAction = 'cancel' | 'expire' | 'mark-paid' | 'fulfill';

export const orderKeys = {
  all: ['orders'] as const,
  list: (f: OrderListFilter) => ['orders', 'list', f] as const,
  detail: (id: string) => ['orders', 'detail', id] as const,
  ledger: (id: string) => ['orders', 'ledger', id] as const,
};

export function useOrders(filter: OrderListFilter) {
  return useQuery({
    queryKey: orderKeys.list(filter),
    queryFn: () =>
      api<{ data: OrderView[]; paging: PagingMeta }>('/orders', { query: { ...filter, limit: 20 } }),
    placeholderData: keepPreviousData,
  });
}

export function useOrder(id: string) {
  return useQuery({
    queryKey: orderKeys.detail(id),
    queryFn: () => api<{ data: OrderView }>(`/orders/${id}`).then((r) => r.data),
  });
}

/** Stock movements booked against the order (ops only: the ledger is supplier data). */
export function useOrderLedger(id: string, enabled: boolean) {
  return useQuery({
    queryKey: orderKeys.ledger(id),
    queryFn: () =>
      api<{ data: InventoryTransactionView[] }>('/inventories/transactions', {
        query: { order_id: id, limit: 100 },
      }).then((r) => r.data),
    enabled,
  });
}

export function useOrderAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: OrderAction) =>
      api<{ data: OrderView }>(`/orders/${id}/${action}`, { method: 'POST' }).then((r) => r.data),
    onSuccess: (order) => {
      qc.setQueryData(orderKeys.detail(id), order);
      void qc.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: CreateOrderRequest; idempotencyKey: string }) =>
      api<{ data: OrderView }>('/orders', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': idempotencyKey },
      }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: orderKeys.all }),
  });
}
