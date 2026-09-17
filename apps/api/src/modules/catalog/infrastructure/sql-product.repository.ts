import { Injectable } from '@nestjs/common';
import {
  type Paging,
  escapeLike,
  isUniqueViolation,
  pagingSql,
  paramBinder,
} from '../../../platform/database/sql';
import type { Tx } from '../../../platform/database/tx';
import { Money } from '../../pricing/domain/money';
import { ProductRepository } from '../application/ports/catalog.repositories';
import type { Product, ProductFilter } from '../domain/catalog';
import { CatalogErrors } from '../domain/errors';

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string;
  base_price: string;
  currency: string;
  uom: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, sku, name, description, base_price, currency, uom, is_active, created_at, updated_at';

const toProduct = (r: ProductRow): Product => ({
  id: r.id,
  sku: r.sku,
  name: r.name,
  description: r.description,
  basePrice: Money.fromDb(r.base_price),
  currency: r.currency,
  uom: r.uom,
  isActive: r.is_active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

@Injectable()
export class SqlProductRepository extends ProductRepository {
  async create(
    tx: Tx,
    data: { sku: string; name: string; description: string; basePrice: Money; uom: string },
  ): Promise<Product> {
    try {
      const [row] = await tx.query<ProductRow>(
        `INSERT INTO products (sku, name, description, base_price, uom)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [data.sku, data.name, data.description, data.basePrice.toString(), data.uom],
      );
      return toProduct(row!);
    } catch (err) {
      if (isUniqueViolation(err, 'products_sku_key')) throw CatalogErrors.skuAlreadyExists();
      throw err;
    }
  }

  async findById(tx: Tx, id: string): Promise<Product | null> {
    const [row] = await tx.query<ProductRow>(`SELECT ${COLUMNS} FROM products WHERE id = $1`, [id]);
    return row ? toProduct(row) : null;
  }

  async findBySku(tx: Tx, sku: string): Promise<Product | null> {
    const [row] = await tx.query<ProductRow>(`SELECT ${COLUMNS} FROM products WHERE sku = $1`, [sku]);
    return row ? toProduct(row) : null;
  }

  async findByIds(tx: Tx, ids: readonly string[]): Promise<Map<string, Product>> {
    const rows = await tx.query<ProductRow>(`SELECT ${COLUMNS} FROM products WHERE id = ANY($1::uuid[])`, [
      [...ids],
    ]);
    return new Map(rows.map((r) => [r.id, toProduct(r)]));
  }

  async list(tx: Tx, filter: ProductFilter, paging: Paging): Promise<Product[]> {
    const params: unknown[] = [];
    const bind = paramBinder(params);
    const where = ['TRUE'];
    if (filter.sku) where.push(`sku = ${bind(filter.sku)}`);
    if (filter.name) where.push(`name ILIKE ${bind(`%${escapeLike(filter.name)}%`)}`);
    if (filter.isActive !== undefined) where.push(`is_active = ${bind(filter.isActive)}`);
    const rows = await tx.query<ProductRow>(
      `SELECT ${COLUMNS} FROM products
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        ${pagingSql(paging, params)}`,
      params,
    );
    return rows.map(toProduct);
  }

  async update(
    tx: Tx,
    id: string,
    data: { name: string; description: string; basePrice: Money; isActive?: boolean },
  ): Promise<Product | null> {
    const [row] = await tx.query<ProductRow>(
      `UPDATE products
          SET name = $2, description = $3, base_price = $4,
              is_active = COALESCE($5, is_active), updated_at = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [id, data.name, data.description, data.basePrice.toString(), data.isActive ?? null],
    );
    return row ? toProduct(row) : null;
  }
}
