import type { ProductView, WarehouseView } from '@stockflow/contracts';
import type { Product, Warehouse } from '../domain/catalog';

// Money leaves the API as a decimal string ("65000.50"), never a JSON number.

export const presentProduct = (p: Product): ProductView => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  description: p.description,
  base_price: p.basePrice.toString(),
  currency: p.currency,
  uom: p.uom,
  is_active: p.isActive,
  created_at: p.createdAt.toISOString(),
  updated_at: p.updatedAt.toISOString(),
});

export const presentWarehouse = (w: Warehouse): WarehouseView => ({
  id: w.id,
  code: w.code,
  name: w.name,
  address: w.address,
  is_active: w.isActive,
  created_at: w.createdAt.toISOString(),
  updated_at: w.updatedAt.toISOString(),
});
