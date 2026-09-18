import type {
  CreateProductRequest,
  CreateWarehouseRequest,
  PagingMeta,
  ProductView,
  UpdateProductRequest,
  UpdateWarehouseRequest,
  WarehouseView,
} from '@stockflow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

// Products and warehouses (StockFlow /products, /warehouses). Reads are open to any
// authenticated role; writes require ops_admin (enforced by the API, mirrored in the UI).

export interface ProductListFilter {
  page: number;
  sku?: string;
  name?: string;
  is_active?: boolean;
}

export interface WarehouseListFilter {
  page: number;
  code?: string;
  name?: string;
  is_active?: boolean;
}

export const catalogKeys = {
  products: {
    active: ['products', 'active'] as const,
    list: (f: ProductListFilter) => ['products', 'list', f] as const,
    detail: (id: string) => ['products', 'detail', id] as const,
  },
  warehouses: {
    active: ['warehouses', 'active'] as const,
    list: (f: WarehouseListFilter) => ['warehouses', 'list', f] as const,
    detail: (id: string) => ['warehouses', 'detail', id] as const,
  },
};

// ── Products ─────────────────────────────────────────────────────────

/** Every active product, unpaged: the reference list order/quote forms build from. */
export function useActiveProducts() {
  return useQuery({
    queryKey: catalogKeys.products.active,
    queryFn: () =>
      api<{ data: ProductView[] }>('/products', { query: { is_active: true, limit: 100 } }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useProductList(filter: ProductListFilter) {
  return useQuery({
    queryKey: catalogKeys.products.list(filter),
    queryFn: () => api<{ data: ProductView[]; paging: PagingMeta }>('/products', { query: { ...filter, limit: 20 } }),
  });
}

/** `id: ''` (nothing selected yet) skips the request instead of calling `/products/`. */
export function useProduct(id: string) {
  return useQuery({
    queryKey: catalogKeys.products.detail(id),
    queryFn: () => api<{ data: ProductView }>(`/products/${id}`).then((r) => r.data),
    enabled: id !== '',
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProductRequest) => api<{ data: ProductView }>('/products', { method: 'POST', body }).then((r) => r.data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useUpdateProduct(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProductRequest) =>
      api<{ data: ProductView }>(`/products/${id}`, { method: 'PUT', body }).then((r) => r.data),
    onSuccess: (product) => {
      qc.setQueryData(catalogKeys.products.detail(id), product);
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

// ── Warehouses ───────────────────────────────────────────────────────

/** Every active warehouse, unpaged: the reference list order forms build from. */
export function useActiveWarehouses() {
  return useQuery({
    queryKey: catalogKeys.warehouses.active,
    queryFn: () =>
      api<{ data: WarehouseView[] }>('/warehouses', { query: { is_active: true, limit: 100 } }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useWarehouseList(filter: WarehouseListFilter) {
  return useQuery({
    queryKey: catalogKeys.warehouses.list(filter),
    queryFn: () => api<{ data: WarehouseView[]; paging: PagingMeta }>('/warehouses', { query: { ...filter, limit: 20 } }),
  });
}

/** `id: ''` (nothing selected yet) skips the request instead of calling `/warehouses/`. */
export function useWarehouse(id: string) {
  return useQuery({
    queryKey: catalogKeys.warehouses.detail(id),
    queryFn: () => api<{ data: WarehouseView }>(`/warehouses/${id}`).then((r) => r.data),
    enabled: id !== '',
  });
}

export function useCreateWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWarehouseRequest) =>
      api<{ data: WarehouseView }>('/warehouses', { method: 'POST', body }).then((r) => r.data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['warehouses'] }),
  });
}

export function useUpdateWarehouse(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateWarehouseRequest) =>
      api<{ data: WarehouseView }>(`/warehouses/${id}`, { method: 'PUT', body }).then((r) => r.data),
    onSuccess: (warehouse) => {
      qc.setQueryData(catalogKeys.warehouses.detail(id), warehouse);
      void qc.invalidateQueries({ queryKey: ['warehouses'] });
    },
  });
}
