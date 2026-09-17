import type { Paging } from '../../../../platform/database/sql';
import type { Tx } from '../../../../platform/database/tx';
import type { Money } from '../../../pricing/domain/money';
import type { Product, ProductFilter, Warehouse, WarehouseFilter } from '../../domain/catalog';

export abstract class ProductRepository {
  /** Throws SKU_ALREADY_EXISTS on a duplicate SKU. */
  abstract create(
    tx: Tx,
    data: { sku: string; name: string; description: string; basePrice: Money; uom: string },
  ): Promise<Product>;
  abstract findById(tx: Tx, id: string): Promise<Product | null>;
  abstract findBySku(tx: Tx, sku: string): Promise<Product | null>;
  /** One query for any number of ids; missing ids are simply absent from the map. */
  abstract findByIds(tx: Tx, ids: readonly string[]): Promise<Map<string, Product>>;
  abstract list(tx: Tx, filter: ProductFilter, paging: Paging): Promise<Product[]>;
  /** Null when the product does not exist. Always bumps updated_at. */
  abstract update(
    tx: Tx,
    id: string,
    data: { name: string; description: string; basePrice: Money; isActive?: boolean },
  ): Promise<Product | null>;
}

export abstract class WarehouseRepository {
  /** Throws WAREHOUSE_CODE_ALREADY_EXISTS on a duplicate code. */
  abstract create(tx: Tx, data: { code: string; name: string; address: string }): Promise<Warehouse>;
  abstract findById(tx: Tx, id: string): Promise<Warehouse | null>;
  abstract findByCode(tx: Tx, code: string): Promise<Warehouse | null>;
  abstract list(tx: Tx, filter: WarehouseFilter, paging: Paging): Promise<Warehouse[]>;
  abstract update(
    tx: Tx,
    id: string,
    data: { name: string; address: string; isActive?: boolean },
  ): Promise<Warehouse | null>;
}
