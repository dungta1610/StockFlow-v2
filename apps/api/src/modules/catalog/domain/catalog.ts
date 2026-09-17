import type { Money } from '../../pricing/domain/money';

// Products and warehouses, ported from StockFlow module/product and module/warehouse.

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  /** List price; buyers are charged their resolved contract price. */
  basePrice: Money;
  currency: string;
  uom: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  address: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** SKUs and warehouse codes are stored trimmed and upper-case (StockFlow's Normalize()). */
export const normalizeCode = (code: string): string => code.trim().toUpperCase();

export interface ProductFilter {
  sku?: string;
  name?: string;
  isActive?: boolean;
}

export interface WarehouseFilter {
  code?: string;
  name?: string;
  isActive?: boolean;
}
