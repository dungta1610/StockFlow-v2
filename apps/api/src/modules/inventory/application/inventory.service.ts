import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../platform/database/tx';
import { CatalogService } from '../../catalog/application/catalog.service';
import { CatalogErrors } from '../../catalog/domain/errors';
import { type Actor, assertRole } from '../../identity/domain/actor';
import type { StockLevel } from '../domain/inventory';
import { InventoryRepository } from './ports/inventory.repository';

export interface WarehouseStock extends StockLevel {
  warehouseCode: string;
  warehouseName: string;
}

export interface StockStatus {
  sku: string;
  productName: string;
  total: StockLevel;
  /** One entry per warehouse that holds a row, ordered by code. */
  warehouses: WarehouseStock[];
}

/**
 * What other modules — and the copilot in phase 08 — ask about stock. It takes the
 * codes a person actually has (a SKU from an email, a warehouse code from a label)
 * rather than uuids, and says plainly when a code is unknown instead of returning an
 * empty result that reads like "no stock".
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly inventory: InventoryRepository,
    private readonly catalog: CatalogService,
  ) {}

  async getStatus(
    db: Tx,
    actor: Actor,
    query: { sku: string; warehouseCode?: string },
  ): Promise<StockStatus> {
    assertRole(actor, 'ops', 'ops_admin');
    const product = await this.catalog.findProductBySku(db, query.sku);
    if (!product) throw CatalogErrors.productNotFound();

    let warehouseId: string | undefined;
    if (query.warehouseCode !== undefined) {
      const warehouse = await this.catalog.findWarehouseByCode(db, query.warehouseCode);
      if (!warehouse) throw CatalogErrors.warehouseNotFound();
      warehouseId = warehouse.id;
    }

    const rows = await this.inventory.findByProduct(db, product.id, warehouseId);
    return {
      sku: product.sku,
      productName: product.name,
      total: {
        available: rows.reduce((sum, r) => sum + r.availableQty, 0),
        reserved: rows.reduce((sum, r) => sum + r.reservedQty, 0),
      },
      warehouses: rows.map((r) => ({
        warehouseCode: r.warehouseCode,
        warehouseName: r.warehouseName,
        available: r.availableQty,
        reserved: r.reservedQty,
      })),
    };
  }

  /**
   * Levels of several products in one warehouse, for modules that already hold
   * resolved ids (ordering explains a shortfall, diagnoses an order). A product the
   * warehouse has never stocked reads as zero. No role check: callers decide what of
   * this they may show.
   */
  async levelsAt(db: Tx, warehouseId: string, productIds: readonly string[]): Promise<Map<string, StockLevel>> {
    const found = await this.inventory.findLevels(db, warehouseId, productIds);
    return new Map(productIds.map((id) => [id, found.get(id) ?? { available: 0, reserved: 0 }]));
  }
}
