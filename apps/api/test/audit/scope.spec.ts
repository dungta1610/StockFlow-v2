import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SqlAuditRepository } from '../../src/modules/audit/infrastructure/sql-audit.repository';
import { OutboxRelay } from '../../src/platform/outbox/outbox.relay';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { postOrder, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('GET /ops/audit requires ops_admin and is scoped by organisation', () => {
  let app: INestApplication;
  let relay: OutboxRelay;
  let uow: UnitOfWork;
  let auditRepo: SqlAuditRepository;
  let t: Tenants;
  let product: string;
  let warehouse: string;
  let orderAId: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
    relay = app.get(OutboxRelay);
    uow = app.get(UnitOfWork);
    auditRepo = app.get(SqlAuditRepository);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
    await stockUp(app, t, product, warehouse, 10);
    const buyer = await bearer(server(), 'buyer@a.test');
    const created = await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 1 }] });
    orderAId = created.body.data.id;
    await relay.pollOnce();
  });

  it('lets ops_admin read; ops and buyer both get 403', async () => {
    const opsAdmin = await bearer(server(), 'ops.admin@sf.test');
    const ops = await bearer(server(), 'ops@sf.test');
    const buyer = await bearer(server(), 'buyer@a.test');

    const asAdmin = await request(server()).get('/ops/audit').set('Authorization', opsAdmin);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.data.some((r: { aggregate_id: string }) => r.aggregate_id === orderAId)).toBe(true);

    expect((await request(server()).get('/ops/audit').set('Authorization', ops)).status).toBe(403);
    expect((await request(server()).get('/ops/audit').set('Authorization', buyer)).status).toBe(403);
  });

  it('org_id — not a guessed aggregate_id — gates a row: buyer org B never sees org A\'s row', async () => {
    const scopedToB = await auditRepo.list(
      uow.db,
      { kind: 'single', orgId: t.buyerB },
      { aggregateId: orderAId },
      { page: 1, limit: 10 },
    );
    expect(scopedToB).toEqual([]);

    const scopedToA = await auditRepo.list(
      uow.db,
      { kind: 'single', orgId: t.buyerA },
      { aggregateId: orderAId },
      { page: 1, limit: 10 },
    );
    expect(scopedToA).toHaveLength(1);
    expect(scopedToA[0]!.aggregateId).toBe(orderAId);
  });
});
