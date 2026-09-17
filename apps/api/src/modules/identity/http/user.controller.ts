import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  type CreateUserRequest,
  type ListUsersQuery,
  type UpdateUserRequest,
  createUserRequestSchema,
  listUsersQuerySchema,
  updateUserRequestSchema,
} from '@stockflow/contracts';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import {
  CreateUserUseCase,
  GetUserUseCase,
  ListUsersUseCase,
  UpdateUserUseCase,
} from '../application/use-cases/user.use-cases';
import type { Actor } from '../domain/actor';
import { CurrentActor, Roles } from './auth.decorators';
import { presentUser } from './presenters';

/** StockFlow's /users routes (POST, GET, GET :id, PUT :id), for organisation admins. */
@Controller('users')
@Roles('ops_admin', 'buyer_admin')
export class UserController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly createUseCase: CreateUserUseCase,
    private readonly listUseCase: ListUsersUseCase,
    private readonly getUseCase: GetUserUseCase,
    private readonly updateUseCase: UpdateUserUseCase,
  ) {}

  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createUserRequestSchema)) body: CreateUserRequest,
  ) {
    const user = await this.uow.withTransaction((tx) =>
      this.createUseCase.execute(tx, actor, {
        email: body.email,
        password: body.password,
        fullName: body.full_name,
        orgId: body.org_id,
        role: body.role,
      }),
    );
    return { data: presentUser(user) };
  }

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listUsersQuerySchema)) q: ListUsersQuery,
  ) {
    const paging = { page: q.page, limit: q.limit };
    const users = await this.listUseCase.execute(
      this.uow.db,
      actor,
      { email: q.email, fullName: q.full_name, role: q.role, isActive: q.is_active, orgId: q.org_id },
      paging,
    );
    return { data: users.map(presentUser), paging };
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return { data: presentUser(await this.getUseCase.execute(this.uow.db, actor, id)) };
  }

  @Put(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateUserRequestSchema)) body: UpdateUserRequest,
  ) {
    const user = await this.uow.withTransaction((tx) =>
      this.updateUseCase.execute(tx, actor, id, {
        fullName: body.full_name,
        role: body.role,
        password: body.password,
        isActive: body.is_active,
        orgId: body.org_id,
      }),
    );
    return { data: presentUser(user) };
  }
}
