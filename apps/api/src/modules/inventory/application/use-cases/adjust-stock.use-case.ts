import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../../platform/database/tx';
import { CatalogService } from '../../../catalog/application/catalog.service';
import { CatalogErrors } from '../../../catalog/domain/errors';
import { type Actor, assertRole } from '../../../identity/domain/actor';
import type { InventoryDetail } from '../../domain/inventory';
import { InventoryErrors } from '../../domain/errors';
import { InventoryRepository } from '../ports/inventory.repository';
import { StockMovementService } from '../stock-movement.service';

/** The stock row after an adjustment, plus the ledger entry that recorded it. */
export interface AdjustedStock extends InventoryDetail {
  transactionId: string;
}

/**
 * Ported from StockFlow biz/adjust_stock.go. The movement and its ledger row happen
 * together in the caller's transaction (see StockMovementService), so stock cannot
 * move without leaving a trace.
 */
@Injectable()
export class AdjustStockUseCase {
  constructor(
    private readonly movements: StockMovementService,
    private readonly inventory: InventoryRepository,
    private readonly catalog: CatalogService,
  ) {}

  async execute(
    tx: Tx,
    actor: Actor,
    input: { productId: string; warehouseId: string; quantity: number; reason: string },
  ): Promise<AdjustedStock> {
    assertRole(actor, 'ops', 'ops_admin');
    const { quantity } = input;
    if (!Number.isSafeInteger(quantity) || quantity === 0) throw InventoryErrors.invalidAdjustment();

    // Unknown ids are a 404, not a foreign-key error surfaced as a 500.
    const productId = input.productId.toLowerCase();
    const warehouseId = input.warehouseId.toLowerCase();
    const [product, warehouse] = await Promise.all([
      this.catalog.findProducts(tx, [productId]).then((m) => m.get(productId)),
      this.catalog.findWarehouse(tx, warehouseId),
    ]);
    if (!product) throw CatalogErrors.productNotFound();
    if (!warehouse) throw CatalogErrors.warehouseNotFound();

    const move = await this.movements.adjust(
      tx,
      { productId, warehouseId, delta: quantity },
      { reason: input.reason, createdBy: actor.userId },
    );
    if (!move) throw InventoryErrors.notEnoughStock();

    const detail = await this.inventory.findById(tx, move.inventoryId);
    if (!detail) throw InventoryErrors.inventoryNotFound();
    // The ledger row comes back with the detail so a caller that has to point at
    // the exact entry this produced does not have to guess which one it was.
    return { ...detail, transactionId: move.transactionId };
  }
}
