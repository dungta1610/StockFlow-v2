import type {
  AdjustStockRequest,
  InventoryTransactionView,
  InventoryView,
  PagingMeta,
} from '@stockflow/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

// Stock levels and the append-only ledger (StockFlow /inventories). Ops-only: stock
// is supplier data buyers never see directly (they see availability through quotes
// and order placement instead).

export interface InventoryListFilter {
  page: number;
  product_id?: string;
  warehouse_id?: string;
}

export const inventoryKeys = {
  list: (f: InventoryListFilter) => ['inventory', 'list', f] as const,
  detail: (id: string) => ['inventory', 'detail', id] as const,
  ledger: (inventoryId: string) => ['inventory', 'ledger', inventoryId] as const,
};

export function useInventoryList(filter: InventoryListFilter) {
  return useQuery({
    queryKey: inventoryKeys.list(filter),
    queryFn: () => api<{ data: InventoryView[]; paging: PagingMeta }>('/inventories', { query: { ...filter, limit: 20 } }),
    placeholderData: keepPreviousData,
  });
}

export function useInventoryDetail(id: string) {
  return useQuery({
    queryKey: inventoryKeys.detail(id),
    queryFn: () => api<{ data: InventoryView }>('/inventories/detail', { query: { id } }).then((r) => r.data),
  });
}

/** The full ledger for one stock record: every reserve, release, consume and manual adjustment. */
export function useInventoryLedger(inventoryId: string) {
  return useQuery({
    queryKey: inventoryKeys.ledger(inventoryId),
    queryFn: () =>
      api<{ data: InventoryTransactionView[] }>('/inventories/transactions', {
        query: { inventory_id: inventoryId, limit: 100 },
      }).then((r) => r.data),
  });
}

export function useAdjustStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AdjustStockRequest) =>
      api<{ data: InventoryView }>('/inventories/adjust', { method: 'POST', body }).then((r) => r.data),
    onSuccess: (inventory) => {
      qc.setQueryData(inventoryKeys.detail(inventory.id), inventory);
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}
