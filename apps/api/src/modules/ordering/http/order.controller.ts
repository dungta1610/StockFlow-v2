import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import {
  type CreateOrderRequest,
  type ListOrdersQuery,
  createOrderRequestSchema,
  idempotencyKeySchema,
  listOrdersQuerySchema,
} from '@stockflow/contracts';
import type { Response } from 'express';
import type { Tx } from '../../../platform/database/tx';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import type { OrgScope } from '../../identity/domain/org-scope';
import { CurrentActor, CurrentScope, Roles } from '../../identity/http/auth.decorators';
import { type HttpResult, IdempotencyService } from '../application/idempotency.service';
import { OrderService } from '../application/order.service';
import { CreateOrderUseCase } from '../application/use-cases/create-order.use-case';
import {
  CancelOrderUseCase,
  ExpireOrderUseCase,
  FulfillOrderUseCase,
  MarkOrderPaidUseCase,
  type OrderRef,
} from '../application/use-cases/order-transition.use-cases';
import type { OrderWithItems } from '../domain/order';
import { presentOrder } from './presenters';

const CREATE_ENDPOINT = 'POST /orders';

// Nest's @Headers() takes no pipes, so the header is validated in the handler.
const idempotencyKeyPipe = new ZodValidationPipe(idempotencyKeySchema.optional());

interface TransitionUseCase {
  execute(tx: Tx, actor: Actor, input: OrderRef): Promise<OrderWithItems>;
}

/** StockFlow's /orders routes, plus mark-paid and fulfil. One request, one transaction. */
@Controller('orders')
export class OrderController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly idempotency: IdempotencyService,
    private readonly orders: OrderService,
    private readonly createUseCase: CreateOrderUseCase,
    private readonly cancelUseCase: CancelOrderUseCase,
    private readonly expireUseCase: ExpireOrderUseCase,
    private readonly markPaidUseCase: MarkOrderPaidUseCase,
    private readonly fulfillUseCase: FulfillOrderUseCase,
  ) {}

  /**
   * With an `Idempotency-Key` header, a repeat of the same request replays the first
   * response instead of placing a second order.
   */
  @Post()
  @Roles('buyer', 'buyer_admin')
  async create(
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body(new ZodValidationPipe(createOrderRequestSchema)) body: CreateOrderRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKeyPipe.transform(rawKey);
    const work = async (tx: Tx): Promise<HttpResult> => {
      const order = await this.createUseCase.execute(
        tx,
        actor,
        {
          warehouseId: body.warehouse_id,
          items: body.items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
        },
        new Date(),
      );
      return { status: 201, body: { data: presentOrder(order) } };
    };

    const result =
      key === undefined
        ? await this.uow.withTransaction(work)
        : await this.idempotency.execute(
            {
              orgId: actor.orgId,
              endpoint: CREATE_ENDPOINT,
              key,
              requestHash: IdempotencyService.hashRequest(body),
            },
            work,
          );
    res.status(result.status);
    return result.body;
  }

  @Get()
  async list(
    @CurrentScope() scope: OrgScope,
    @Query(new ZodValidationPipe(listOrdersQuerySchema)) q: ListOrdersQuery,
  ) {
    const paging = { page: q.page, limit: q.limit };
    const orders = await this.orders.list(
      this.uow.db,
      scope,
      { status: q.status, orderCode: q.order_code, warehouseId: q.warehouse_id, buyerOrgId: q.buyer_org_id },
      paging,
    );
    return { data: orders.map(presentOrder), paging };
  }

  @Get(':id')
  async get(@CurrentScope() scope: OrgScope, @Param('id', ParseUUIDPipe) id: string) {
    return { data: presentOrder(await this.orders.get(this.uow.db, scope, id)) };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.transition(this.cancelUseCase, actor, id);
  }

  @Post(':id/expire')
  @HttpCode(200)
  @Roles('ops', 'ops_admin')
  expire(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.transition(this.expireUseCase, actor, id);
  }

  @Post(':id/mark-paid')
  @HttpCode(200)
  @Roles('ops', 'ops_admin')
  markPaid(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.transition(this.markPaidUseCase, actor, id);
  }

  @Post(':id/fulfill')
  @HttpCode(200)
  @Roles('ops', 'ops_admin')
  fulfill(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.transition(this.fulfillUseCase, actor, id);
  }

  private async transition(useCase: TransitionUseCase, actor: Actor, orderId: string) {
    const order = await this.uow.withTransaction((tx) => useCase.execute(tx, actor, { orderId }));
    return { data: presentOrder(order) };
  }
}
