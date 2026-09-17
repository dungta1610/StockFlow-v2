import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  type CreateWarehouseRequest,
  type ListWarehousesQuery,
  type UpdateWarehouseRequest,
  createWarehouseRequestSchema,
  listWarehousesQuerySchema,
  updateWarehouseRequestSchema,
} from '@stockflow/contracts';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, Roles } from '../../identity/http/auth.decorators';
import {
  CreateWarehouseUseCase,
  GetWarehouseUseCase,
  ListWarehousesUseCase,
  UpdateWarehouseUseCase,
} from '../application/use-cases/warehouse.use-cases';
import { presentWarehouse } from './presenters';

@Controller('warehouses')
export class WarehouseController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly createUseCase: CreateWarehouseUseCase,
    private readonly getUseCase: GetWarehouseUseCase,
    private readonly listUseCase: ListWarehousesUseCase,
    private readonly updateUseCase: UpdateWarehouseUseCase,
  ) {}

  @Post()
  @Roles('ops_admin')
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createWarehouseRequestSchema)) body: CreateWarehouseRequest,
  ) {
    const warehouse = await this.uow.withTransaction((tx) =>
      this.createUseCase.execute(tx, actor, body),
    );
    return { data: presentWarehouse(warehouse) };
  }

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listWarehousesQuerySchema)) q: ListWarehousesQuery,
  ) {
    const paging = { page: q.page, limit: q.limit };
    const warehouses = await this.listUseCase.execute(
      this.uow.db,
      actor,
      { code: q.code, name: q.name, isActive: q.is_active },
      paging,
    );
    return { data: warehouses.map(presentWarehouse), paging };
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return { data: presentWarehouse(await this.getUseCase.execute(this.uow.db, actor, id)) };
  }

  @Put(':id')
  @Roles('ops_admin')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateWarehouseRequestSchema)) body: UpdateWarehouseRequest,
  ) {
    const warehouse = await this.uow.withTransaction((tx) =>
      this.updateUseCase.execute(tx, actor, id, {
        name: body.name,
        address: body.address,
        isActive: body.is_active,
      }),
    );
    return { data: presentWarehouse(warehouse) };
  }
}
