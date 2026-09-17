import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  type CreateProductRequest,
  type ListProductsQuery,
  type UpdateProductRequest,
  createProductRequestSchema,
  listProductsQuerySchema,
  updateProductRequestSchema,
} from '@stockflow/contracts';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, Roles } from '../../identity/http/auth.decorators';
import {
  CreateProductUseCase,
  GetProductUseCase,
  ListProductsUseCase,
  UpdateProductUseCase,
} from '../application/use-cases/product.use-cases';
import { presentProduct } from './presenters';

@Controller('products')
export class ProductController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly createUseCase: CreateProductUseCase,
    private readonly getUseCase: GetProductUseCase,
    private readonly listUseCase: ListProductsUseCase,
    private readonly updateUseCase: UpdateProductUseCase,
  ) {}

  @Post()
  @Roles('ops_admin')
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createProductRequestSchema)) body: CreateProductRequest,
  ) {
    const product = await this.uow.withTransaction((tx) =>
      this.createUseCase.execute(tx, actor, {
        sku: body.sku,
        name: body.name,
        description: body.description,
        basePrice: body.base_price,
        uom: body.uom,
      }),
    );
    return { data: presentProduct(product) };
  }

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listProductsQuerySchema)) q: ListProductsQuery,
  ) {
    const paging = { page: q.page, limit: q.limit };
    const products = await this.listUseCase.execute(
      this.uow.db,
      actor,
      { sku: q.sku, name: q.name, isActive: q.is_active },
      paging,
    );
    return { data: products.map(presentProduct), paging };
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return { data: presentProduct(await this.getUseCase.execute(this.uow.db, actor, id)) };
  }

  @Put(':id')
  @Roles('ops_admin')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateProductRequestSchema)) body: UpdateProductRequest,
  ) {
    const product = await this.uow.withTransaction((tx) =>
      this.updateUseCase.execute(tx, actor, id, {
        name: body.name,
        description: body.description,
        basePrice: body.base_price,
        isActive: body.is_active,
      }),
    );
    return { data: presentProduct(product) };
  }
}
