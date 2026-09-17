import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  type CreatePriceListRequest,
  type ListPriceListsQuery,
  type UpsertPriceListItemsRequest,
  createPriceListRequestSchema,
  listPriceListsQuerySchema,
  upsertPriceListItemsRequestSchema,
} from '@stockflow/contracts';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, Roles } from '../../identity/http/auth.decorators';
import {
  ArchivePriceListUseCase,
  CreatePriceListUseCase,
  GetPriceListUseCase,
  ListPriceListsUseCase,
  UpsertPriceListItemsUseCase,
} from '../application/use-cases/price-list.use-cases';
import { presentPriceList } from './presenters';

@Controller('price-lists')
@Roles('ops', 'ops_admin')
export class PriceListController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly createUseCase: CreatePriceListUseCase,
    private readonly upsertItemsUseCase: UpsertPriceListItemsUseCase,
    private readonly archiveUseCase: ArchivePriceListUseCase,
    private readonly listUseCase: ListPriceListsUseCase,
    private readonly getUseCase: GetPriceListUseCase,
  ) {}

  @Post()
  @Roles('ops_admin')
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createPriceListRequestSchema)) body: CreatePriceListRequest,
  ) {
    const list = await this.uow.withTransaction((tx) =>
      this.createUseCase.execute(tx, actor, {
        orgId: body.org_id,
        name: body.name,
        validFrom: new Date(body.valid_from),
        validTo: body.valid_to === null ? null : new Date(body.valid_to),
        priority: body.priority,
      }),
    );
    return { data: presentPriceList(list) };
  }

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listPriceListsQuerySchema)) q: ListPriceListsQuery,
  ) {
    const paging = { page: q.page, limit: q.limit };
    const lists = await this.listUseCase.execute(
      this.uow.db,
      actor,
      { orgId: q.org_id, status: q.status },
      paging,
    );
    return { data: lists.map(presentPriceList), paging };
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return { data: presentPriceList(await this.getUseCase.execute(this.uow.db, actor, id)) };
  }

  @Post(':id/items')
  @HttpCode(200)
  @Roles('ops_admin')
  async upsertItems(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(upsertPriceListItemsRequestSchema)) body: UpsertPriceListItemsRequest,
  ) {
    const list = await this.uow.withTransaction((tx) =>
      this.upsertItemsUseCase.execute(
        tx,
        actor,
        id,
        body.items.map((i) => ({ productId: i.product_id, minQty: i.min_qty, unitPrice: i.unit_price })),
      ),
    );
    return { data: presentPriceList(list) };
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Roles('ops_admin')
  async archive(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    const list = await this.uow.withTransaction((tx) => this.archiveUseCase.execute(tx, actor, id));
    return { data: presentPriceList(list) };
  }
}
