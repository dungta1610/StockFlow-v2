import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../platform/database/tx';
import { type Product, type Warehouse, normalizeCode } from '../domain/catalog';
import { ProductRepository, WarehouseRepository } from './ports/catalog.repositories';

/**
 * What other modules may ask the catalog. Pricing, inventory, ordering and the
 * copilot read products and warehouses through here rather than querying catalog
 * tables themselves.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly products: ProductRepository,
    private readonly warehouses: WarehouseRepository,
  ) {}

  findProductBySku(db: Tx, sku: string): Promise<Product | null> {
    return this.products.findBySku(db, normalizeCode(sku));
  }

  findWarehouseByCode(db: Tx, code: string): Promise<Warehouse | null> {
    return this.warehouses.findByCode(db, normalizeCode(code));
  }

  findProducts(db: Tx, ids: readonly string[]): Promise<Map<string, Product>> {
    return this.products.findByIds(db, ids);
  }

  findWarehouse(db: Tx, id: string): Promise<Warehouse | null> {
    return this.warehouses.findById(db, id);
  }
}
