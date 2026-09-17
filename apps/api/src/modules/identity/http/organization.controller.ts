import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  type CreateOrganizationRequest,
  type ListOrganizationsQuery,
  createOrganizationRequestSchema,
  listOrganizationsQuerySchema,
} from '@stockflow/contracts';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import {
  CreateOrganizationUseCase,
  GetOrganizationUseCase,
  ListOrganizationsUseCase,
} from '../application/use-cases/organization.use-cases';
import type { Actor } from '../domain/actor';
import { CurrentActor, Roles } from './auth.decorators';
import { presentOrganization } from './presenters';

@Controller('organizations')
export class OrganizationController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly createUseCase: CreateOrganizationUseCase,
    private readonly listUseCase: ListOrganizationsUseCase,
    private readonly getUseCase: GetOrganizationUseCase,
  ) {}

  @Post()
  @Roles('ops_admin')
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createOrganizationRequestSchema)) body: CreateOrganizationRequest,
  ) {
    const org = await this.uow.withTransaction((tx) =>
      this.createUseCase.execute(tx, actor, {
        code: body.code,
        name: body.name,
        type: body.type,
        taxCode: body.tax_code,
      }),
    );
    return { data: presentOrganization(org) };
  }

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listOrganizationsQuerySchema)) q: ListOrganizationsQuery,
  ) {
    const paging = { page: q.page, limit: q.limit };
    const orgs = await this.listUseCase.execute(this.uow.db, actor, { code: q.code, type: q.type }, paging);
    return { data: orgs.map(presentOrganization), paging };
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return { data: presentOrganization(await this.getUseCase.execute(this.uow.db, actor, id)) };
  }
}
