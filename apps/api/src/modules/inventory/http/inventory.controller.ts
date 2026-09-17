import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  type AdjustStockRequest,
  type InventoryDetailQuery,
  type ListInventoryQuery,
  type ListInventoryTransactionsQuery,
  adjustStockRequestSchema,
  inventoryDetailQuerySchema,
  listInventoryQuerySchema,
  listInventoryTransactionsQuerySchema,
} from '@stockflow/contracts';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, Roles } from '../../identity/http/auth.decorators';
import { AdjustStockUseCase } from '../application/use-cases/adjust-stock.use-case';
import {
  GetInventoryUseCase,
  ListInventoryTransactionsUseCase,
  ListInventoryUseCase,
} from '../application/use-cases/read-inventory.use-cases';
import { presentInventory, presentTransaction } from './presenters';

/** StockFlow's /inventories routes. Stock is supplier data, so ops only. */
@Controller('inventories')
@Roles('ops', 'ops_admin')
export class InventoryController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly adjustUseCase: AdjustStockUseCase,
    private readonly getUseCase: GetInventoryUseCase,
    private readonly listUseCase: ListInventoryUseCase,
    private readonly transactionsUseCase: ListInventoryTransactionsUseCase,
  ) {}

  @Post('adjust')
  @HttpCode(200)
  async adjust(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(adjustStockRequestSchema)) body: AdjustStockRequest,
  ) {
    // The stock move and its ledger row share one transaction: either both land or
    // neither does.
    const inventory = await this.uow.withTransaction((tx) =>
      this.adjustUseCase.execute(tx, actor, {
        productId: body.product_id,
        warehouseId: body.warehouse_id,
        quantity: body.quantity,
        reason: body.reason,
      }),
    );
    return { data: presentInventory(inventory) };
  }

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listInventoryQuerySchema)) q: ListInventoryQuery,
  ) {
    const paging = { page: q.page, limit: q.limit };
    const rows = await this.listUseCase.execute(
      this.uow.db,
      actor,
      { productId: q.product_id, warehouseId: q.warehouse_id },
      paging,
    );
    return { data: rows.map(presentInventory), paging };
  }

  @Get('detail')
  async detail(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(inventoryDetailQuerySchema)) q: InventoryDetailQuery,
  ) {
    const inventory = await this.getUseCase.execute(this.uow.db, actor, {
      id: q.id,
      productId: q.product_id,
      warehouseId: q.warehouse_id,
    });
    return { data: presentInventory(inventory) };
  }

  @Get('transactions')
  async transactions(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listInventoryTransactionsQuerySchema)) q: ListInventoryTransactionsQuery,
  ) {
    const paging = { page: q.page, limit: q.limit };
    const rows = await this.transactionsUseCase.execute(
      this.uow.db,
      actor,
      {
        inventoryId: q.inventory_id,
        productId: q.product_id,
        warehouseId: q.warehouse_id,
        orderId: q.order_id,
        reservationId: q.reservation_id,
        txnType: q.txn_type,
      },
      paging,
    );
    return { data: rows.map(presentTransaction), paging };
  }
}
