import { Injectable } from '@nestjs/common';
import type { Paging } from '../../../../platform/database/sql';
import type { Tx } from '../../../../platform/database/tx';
import { type Actor, assertRole } from '../../../identity/domain/actor';
import { type Warehouse, type WarehouseFilter, normalizeCode } from '../../domain/catalog';
import { CatalogErrors } from '../../domain/errors';
import { WarehouseRepository } from '../ports/catalog.repositories';

// Ported from StockFlow module/warehouse/biz (create, get, list), plus update.

@Injectable()
export class CreateWarehouseUseCase {
  constructor(private readonly warehouses: WarehouseRepository) {}

  async execute(
    tx: Tx,
    actor: Actor,
    input: { code: string; name: string; address: string },
  ): Promise<Warehouse> {
    assertRole(actor, 'ops_admin');
    return this.warehouses.create(tx, {
      code: normalizeCode(input.code),
      name: input.name.trim(),
      address: input.address.trim(),
    });
  }
}

@Injectable()
export class GetWarehouseUseCase {
  constructor(private readonly warehouses: WarehouseRepository) {}

  async execute(db: Tx, _actor: Actor, id: string): Promise<Warehouse> {
    const warehouse = await this.warehouses.findById(db, id);
    if (!warehouse) throw CatalogErrors.warehouseNotFound();
    return warehouse;
  }
}

@Injectable()
export class ListWarehousesUseCase {
  constructor(private readonly warehouses: WarehouseRepository) {}

  async execute(db: Tx, _actor: Actor, filter: WarehouseFilter, paging: Paging): Promise<Warehouse[]> {
    const code = filter.code === undefined ? undefined : normalizeCode(filter.code);
    return this.warehouses.list(db, { ...filter, code }, paging);
  }
}

@Injectable()
export class UpdateWarehouseUseCase {
  constructor(private readonly warehouses: WarehouseRepository) {}

  async execute(
    tx: Tx,
    actor: Actor,
    id: string,
    input: { name: string; address: string; isActive?: boolean },
  ): Promise<Warehouse> {
    assertRole(actor, 'ops_admin');
    const warehouse = await this.warehouses.update(tx, id, {
      name: input.name.trim(),
      address: input.address.trim(),
      isActive: input.isActive,
    });
    if (!warehouse) throw CatalogErrors.warehouseNotFound();
    return warehouse;
  }
}
