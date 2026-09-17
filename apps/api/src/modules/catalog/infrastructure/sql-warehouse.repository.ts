import { Injectable } from '@nestjs/common';
import {
  type Paging,
  escapeLike,
  isUniqueViolation,
  pagingSql,
  paramBinder,
} from '../../../platform/database/sql';
import type { Tx } from '../../../platform/database/tx';
import { WarehouseRepository } from '../application/ports/catalog.repositories';
import type { Warehouse, WarehouseFilter } from '../domain/catalog';
import { CatalogErrors } from '../domain/errors';

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  address: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, code, name, address, is_active, created_at, updated_at';

const toWarehouse = (r: WarehouseRow): Warehouse => ({
  id: r.id,
  code: r.code,
  name: r.name,
  address: r.address,
  isActive: r.is_active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

@Injectable()
export class SqlWarehouseRepository extends WarehouseRepository {
  async create(tx: Tx, data: { code: string; name: string; address: string }): Promise<Warehouse> {
    try {
      const [row] = await tx.query<WarehouseRow>(
        `INSERT INTO warehouses (code, name, address) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
        [data.code, data.name, data.address],
      );
      return toWarehouse(row!);
    } catch (err) {
      if (isUniqueViolation(err, 'warehouses_code_key')) throw CatalogErrors.warehouseCodeAlreadyExists();
      throw err;
    }
  }

  async findById(tx: Tx, id: string): Promise<Warehouse | null> {
    const [row] = await tx.query<WarehouseRow>(`SELECT ${COLUMNS} FROM warehouses WHERE id = $1`, [id]);
    return row ? toWarehouse(row) : null;
  }

  async findByCode(tx: Tx, code: string): Promise<Warehouse | null> {
    const [row] = await tx.query<WarehouseRow>(`SELECT ${COLUMNS} FROM warehouses WHERE code = $1`, [code]);
    return row ? toWarehouse(row) : null;
  }

  async list(tx: Tx, filter: WarehouseFilter, paging: Paging): Promise<Warehouse[]> {
    const params: unknown[] = [];
    const bind = paramBinder(params);
    const where = ['TRUE'];
    if (filter.code) where.push(`code = ${bind(filter.code)}`);
    if (filter.name) where.push(`name ILIKE ${bind(`%${escapeLike(filter.name)}%`)}`);
    if (filter.isActive !== undefined) where.push(`is_active = ${bind(filter.isActive)}`);
    const rows = await tx.query<WarehouseRow>(
      `SELECT ${COLUMNS} FROM warehouses
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        ${pagingSql(paging, params)}`,
      params,
    );
    return rows.map(toWarehouse);
  }

  async update(
    tx: Tx,
    id: string,
    data: { name: string; address: string; isActive?: boolean },
  ): Promise<Warehouse | null> {
    const [row] = await tx.query<WarehouseRow>(
      `UPDATE warehouses
          SET name = $2, address = $3, is_active = COALESCE($4, is_active), updated_at = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [id, data.name, data.address, data.isActive ?? null],
    );
    return row ? toWarehouse(row) : null;
  }
}
