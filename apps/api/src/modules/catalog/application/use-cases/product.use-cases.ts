import { Injectable } from '@nestjs/common';
import type { Paging } from '../../../../platform/database/sql';
import type { Tx } from '../../../../platform/database/tx';
import { type Actor, assertRole, isInternalOps } from '../../../identity/domain/actor';
import { Money } from '../../../pricing/domain/money';
import { type Product, type ProductFilter, normalizeCode } from '../../domain/catalog';
import { CatalogErrors } from '../../domain/errors';
import { ProductRepository } from '../ports/catalog.repositories';

// Ported from StockFlow module/product/biz (create, get, list), plus update.
// Any signed-in caller may read the catalog, but only ops see discontinued products
// (buyers cannot order them anyway); only ops_admin changes it.

@Injectable()
export class CreateProductUseCase {
  constructor(private readonly products: ProductRepository) {}

  async execute(
    tx: Tx,
    actor: Actor,
    input: { sku: string; name: string; description: string; basePrice: string; uom: string },
  ): Promise<Product> {
    assertRole(actor, 'ops_admin');
    return this.products.create(tx, {
      sku: normalizeCode(input.sku),
      name: input.name.trim(),
      description: input.description.trim(),
      basePrice: Money.parse(input.basePrice),
      uom: input.uom.trim(),
    });
  }
}

@Injectable()
export class GetProductUseCase {
  constructor(private readonly products: ProductRepository) {}

  async execute(db: Tx, actor: Actor, id: string): Promise<Product> {
    const product = await this.products.findById(db, id);
    if (!product || (!product.isActive && !isInternalOps(actor))) throw CatalogErrors.productNotFound();
    return product;
  }
}

@Injectable()
export class ListProductsUseCase {
  constructor(private readonly products: ProductRepository) {}

  async execute(db: Tx, actor: Actor, filter: ProductFilter, paging: Paging): Promise<Product[]> {
    const sku = filter.sku === undefined ? undefined : normalizeCode(filter.sku);
    // A buyer asking for inactive products gets an empty page, not an error.
    const isActive = isInternalOps(actor) ? filter.isActive : filter.isActive === false ? null : true;
    if (isActive === null) return [];
    return this.products.list(db, { ...filter, sku, isActive }, paging);
  }
}

@Injectable()
export class UpdateProductUseCase {
  constructor(private readonly products: ProductRepository) {}

  async execute(
    tx: Tx,
    actor: Actor,
    id: string,
    input: { name: string; description: string; basePrice: string; isActive?: boolean },
  ): Promise<Product> {
    assertRole(actor, 'ops_admin');
    const product = await this.products.update(tx, id, {
      name: input.name.trim(),
      description: input.description.trim(),
      basePrice: Money.parse(input.basePrice),
      isActive: input.isActive,
    });
    if (!product) throw CatalogErrors.productNotFound();
    return product;
  }
}
