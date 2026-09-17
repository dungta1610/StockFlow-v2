import type { INestApplication } from '@nestjs/common';
import { OrganizationRepository } from '../../src/modules/identity/application/ports/organization.repository';
import { CreateOrganizationUseCase } from '../../src/modules/identity/application/use-cases/organization.use-cases';
import {
  CreateUserUseCase,
  GetUserUseCase,
  ListUsersUseCase,
  UpdateUserUseCase,
} from '../../src/modules/identity/application/use-cases/user.use-cases';
import type { Actor } from '../../src/modules/identity/domain/actor';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { seedTenants, type Tenants } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

// Application services are also called outside HTTP (scheduled jobs, agent tools),
// where route decorators do not run. Authorisation must hold at this layer too.
describe('authorisation inside use cases (no HTTP guards involved)', () => {
  let app: INestApplication;
  let uow: UnitOfWork;
  let t: Tenants;
  const paging = { page: 1, limit: 10 };

  beforeAll(async () => {
    app = await createTestApp();
    uow = app.get(UnitOfWork);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
  });

  const buyer = (): Actor => ({ userId: t.users.buyerA, orgId: t.buyerA, orgType: 'buyer', roles: ['buyer'] });
  const ops = (): Actor => ({ userId: t.users.ops, orgId: t.internal, orgType: 'internal', roles: ['ops'] });
  // A forged actor: ops_admin role claimed from a buyer organisation.
  const fakeOpsAdmin = (): Actor => ({
    userId: t.users.adminA,
    orgId: t.buyerA,
    orgType: 'buyer',
    roles: ['ops_admin'],
  });

  const forbidden = { code: 'FORBIDDEN', status: 403 };

  it('a plain buyer cannot list, read, create or update users', async () => {
    await expect(app.get(ListUsersUseCase).execute(uow.db, buyer(), {}, paging)).rejects.toMatchObject(forbidden);
    await expect(app.get(GetUserUseCase).execute(uow.db, buyer(), t.users.buyerA)).rejects.toMatchObject(forbidden);
    await expect(
      uow.withTransaction((tx) =>
        app.get(CreateUserUseCase).execute(tx, buyer(), {
          email: 'x@a.test',
          password: 'password-123',
          fullName: 'X',
          orgId: t.buyerA,
          role: 'buyer_admin',
        }),
      ),
    ).rejects.toMatchObject(forbidden);
    await expect(
      uow.withTransaction((tx) =>
        app.get(UpdateUserUseCase).execute(tx, buyer(), t.users.buyerA, { fullName: 'X', role: 'buyer_admin' }),
      ),
    ).rejects.toMatchObject(forbidden);
  });

  it('ops (non-admin) cannot create organisations or administer users', async () => {
    await expect(
      uow.withTransaction((tx) =>
        app.get(CreateOrganizationUseCase).execute(tx, ops(), { code: 'NEW', name: 'New', type: 'buyer' }),
      ),
    ).rejects.toMatchObject(forbidden);
    await expect(app.get(ListUsersUseCase).execute(uow.db, ops(), {}, paging)).rejects.toMatchObject(forbidden);
  });

  it('an ops role claimed from a buyer organisation grants nothing', async () => {
    await expect(
      uow.withTransaction((tx) =>
        app.get(CreateOrganizationUseCase).execute(tx, fakeOpsAdmin(), { code: 'NEW', name: 'New', type: 'buyer' }),
      ),
    ).rejects.toMatchObject(forbidden);
  });
});

// The `all-buyers` scope is what the ops console will use for commerce data.
describe('all-buyers scope against the database', () => {
  let app: INestApplication;
  let uow: UnitOfWork;
  let repo: OrganizationRepository;
  let t: Tenants;

  beforeAll(async () => {
    app = await createTestApp();
    uow = app.get(UnitOfWork);
    repo = app.get(OrganizationRepository);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
  });

  it('lists every buyer organisation and never the internal one', async () => {
    const orgs = await repo.list(uow.db, { kind: 'all-buyers' }, {}, { page: 1, limit: 100 });
    expect(orgs.map((o) => o.code).sort()).toEqual(['BUYER-A', 'BUYER-B']);
  });

  it('finds a buyer organisation by id but not the internal one', async () => {
    expect(await repo.findById(uow.db, { kind: 'all-buyers' }, t.buyerB)).toMatchObject({ code: 'BUYER-B' });
    expect(await repo.findById(uow.db, { kind: 'all-buyers' }, t.internal)).toBeNull();
  });

  it('single scope reaches exactly one organisation', async () => {
    const orgs = await repo.list(uow.db, { kind: 'single', orgId: t.buyerA }, {}, { page: 1, limit: 100 });
    expect(orgs.map((o) => o.id)).toEqual([t.buyerA]);
    expect(await repo.findById(uow.db, { kind: 'single', orgId: t.buyerA }, t.buyerB)).toBeNull();
  });
});
