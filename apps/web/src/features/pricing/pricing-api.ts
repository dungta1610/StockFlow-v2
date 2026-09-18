import type {
  CreatePriceListRequest,
  PagingMeta,
  PriceListStatusValue,
  PriceListView,
  QuoteView,
  UpsertPriceListItemsRequest,
} from '@stockflow/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

// Price lists (StockFlow /price-lists) are ops-only reads, ops_admin-only writes;
// buyers see prices only through quotes (/pricing/quote).

export interface PriceListFilter {
  page: number;
  org_id?: string;
  status?: PriceListStatusValue;
}

export const pricingKeys = {
  list: (f: PriceListFilter) => ['price-lists', 'list', f] as const,
  detail: (id: string) => ['price-lists', 'detail', id] as const,
};

export function usePriceLists(filter: PriceListFilter) {
  return useQuery({
    queryKey: pricingKeys.list(filter),
    queryFn: () => api<{ data: PriceListView[]; paging: PagingMeta }>('/price-lists', { query: { ...filter, limit: 20 } }),
    placeholderData: keepPreviousData,
  });
}

export function usePriceList(id: string) {
  return useQuery({
    queryKey: pricingKeys.detail(id),
    queryFn: () => api<{ data: PriceListView }>(`/price-lists/${id}`).then((r) => r.data),
  });
}

export function useCreatePriceList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePriceListRequest) =>
      api<{ data: PriceListView }>('/price-lists', { method: 'POST', body }).then((r) => r.data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['price-lists'] }),
  });
}

export function useUpsertPriceListItems(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertPriceListItemsRequest) =>
      api<{ data: PriceListView }>(`/price-lists/${id}/items`, { method: 'POST', body }).then((r) => r.data),
    onSuccess: (list) => {
      qc.setQueryData(pricingKeys.detail(id), list);
      void qc.invalidateQueries({ queryKey: ['price-lists'] });
    },
  });
}

export function useArchivePriceList(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ data: PriceListView }>(`/price-lists/${id}/archive`, { method: 'POST' }).then((r) => r.data),
    onSuccess: (list) => {
      qc.setQueryData(pricingKeys.detail(id), list);
      void qc.invalidateQueries({ queryKey: ['price-lists'] });
    },
  });
}

/** Server-side prices for a set of lines: the same resolver an order will use. */
export function useQuote(items: { product_id: string; qty: number }[], customerOrgId?: string) {
  return useQuery({
    queryKey: ['quote', items, customerOrgId],
    queryFn: () =>
      api<{ data: QuoteView }>('/pricing/quote', {
        method: 'POST',
        body: { items, ...(customerOrgId && { customer_org_id: customerOrgId }) },
      }).then((r) => r.data),
    enabled: items.length > 0,
    placeholderData: keepPreviousData,
  });
}
