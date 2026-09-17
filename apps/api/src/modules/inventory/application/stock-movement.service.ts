import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../platform/database/tx';
import type { StockMove } from '../domain/inventory';
import type { TxnType } from '../domain/inventory-transaction';
import { InventoryRepository } from './ports/inventory.repository';
import { LedgerRepository } from './ports/ledger.repository';

/** Why a movement happened, and what it belongs to. */
export interface MoveContext {
  reason?: string;
  createdBy?: string | null;
  orderId?: string | null;
  reservationId?: string | null;
}

/**
 * The only way stock moves. Each method performs one atomic movement **and** writes
 * its ledger row in the caller's transaction, so "every change to stock leaves a
 * trace" is structural rather than a rule callers must remember. The repository
 * stays inside this module; ordering (phase 04) and the copilot use this service.
 *
 * Every method keeps the repository's null contract: `null` means the condition did
 * not hold, nothing changed, and no ledger row was written.
 */
@Injectable()
export class StockMovementService {
  constructor(
    private readonly inventory: InventoryRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  /** Signed delta from ops. Creates the stock row when the increase is the first one. */
  async adjust(
    tx: Tx,
    input: { productId: string; warehouseId: string; delta: number },
    ctx: MoveContext = {},
  ): Promise<StockMove | null> {
    const move = await this.inventory.adjustAtomic(tx, input.productId, input.warehouseId, input.delta);
    return this.record(tx, move, 'manual_adjustment', Math.abs(input.delta), ctx);
  }

  /** Holds stock for an order: available → reserved. */
  async reserve(
    tx: Tx,
    input: { productId: string; warehouseId: string; qty: number },
    ctx: MoveContext = {},
  ): Promise<StockMove | null> {
    const move = await this.inventory.reserveAtomic(tx, input.productId, input.warehouseId, input.qty);
    return this.record(tx, move, 'reserve', input.qty, ctx);
  }

  /** Gives held stock back: reserved → available. */
  async release(
    tx: Tx,
    input: { inventoryId: string; qty: number },
    ctx: MoveContext = {},
  ): Promise<StockMove | null> {
    const move = await this.inventory.releaseAtomic(tx, input.inventoryId, input.qty);
    return this.record(tx, move, 'release', input.qty, ctx);
  }

  /** The goods have shipped: reserved drops, available is untouched. */
  async consume(
    tx: Tx,
    input: { inventoryId: string; qty: number },
    ctx: MoveContext = {},
  ): Promise<StockMove | null> {
    const move = await this.inventory.consumeAtomic(tx, input.inventoryId, input.qty);
    return this.record(tx, move, 'consume', input.qty, ctx);
  }

  private async record(
    tx: Tx,
    move: StockMove | null,
    txnType: TxnType,
    quantity: number,
    ctx: MoveContext,
  ): Promise<StockMove | null> {
    if (!move) return null;
    await this.ledger.append(tx, {
      inventoryId: move.inventoryId,
      productId: move.productId,
      warehouseId: move.warehouseId,
      txnType,
      quantity,
      beforeAvailableQty: move.before.available,
      afterAvailableQty: move.after.available,
      beforeReservedQty: move.before.reserved,
      afterReservedQty: move.after.reserved,
      reason: ctx.reason ?? '',
      createdBy: ctx.createdBy ?? null,
      orderId: ctx.orderId ?? null,
      reservationId: ctx.reservationId ?? null,
    });
    return move;
  }
}
