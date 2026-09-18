import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { insertOutboxEvent } from '../helpers/outbox-fixtures';
import { postOrder, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('GET /ops/outbox', () => {
  let app: INestApplication;
  let t: Tenants;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
  });

  it('lets ops_admin read; ops and buyer both get 403', async () => {
    const opsAdmin = await bearer(server(), 'ops.admin@sf.test');
    const ops = await bearer(server(), 'ops@sf.test');
    const buyer = await bearer(server(), 'buyer@a.test');

    expect((await request(server()).get('/ops/outbox').set('Authorization', opsAdmin)).status).toBe(200);
    expect((await request(server()).get('/ops/outbox').set('Authorization', ops)).status).toBe(403);
    expect((await request(server()).get('/ops/outbox').set('Authorization', buyer)).status).toBe(403);
  });

  it('filters by status', async () => {
    const opsAdmin = await bearer(server(), 'ops.admin@sf.test');
    const pendingId = await insertOutboxEvent(t.buyerA, { eventType: 'test.pending' });
    const deadId = await insertOutboxEvent(t.buyerA, { eventType: 'test.dead' });
    await withDb((pg) =>
      pg.query(`UPDATE commerce.outbox_events SET status = 'dead', attempts = 8 WHERE id = $1`, [deadId]),
    );

    const dead = await request(server()).get('/ops/outbox').query({ status: 'dead' }).set('Authorization', opsAdmin);
    expect(dead.status).toBe(200);
    expect(dead.body.data.map((r: { id: number; status: string }) => r.id)).toEqual([deadId]);
    expect(dead.body.data[0].status).toBe('dead');

    const pending = await request(server())
      .get('/ops/outbox')
      .query({ status: 'pending' })
      .set('Authorization', opsAdmin);
    expect(pending.body.data.map((r: { id: number }) => r.id)).toContain(pendingId);
    expect(pending.body.data.map((r: { id: number }) => r.id)).not.toContain(deadId);
  });

  it('never returns the raw payload, so no price can leak through this endpoint', async () => {
    const opsAdmin = await bearer(server(), 'ops.admin@sf.test');
    const buyer = await bearer(server(), 'buyer@a.test');
    const product = await withDb((pg) => insertProduct(pg, { sku: 'SKU-1', basePrice: '999.00' }));
    const warehouse = await withDb((pg) => insertWarehouse(pg, { code: 'HN-01' }));
    await stockUp(app, t, product, warehouse, 5);
    const created = await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 1 }] });
    expect(created.status).toBe(201);

    const res = await request(server()).get('/ops/outbox').set('Authorization', opsAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const row of res.body.data) {
      expect(row).not.toHaveProperty('payload');
    }
  });

  it('is scoped: an ops_admin only ever sees buyer-owned events (org_id is always a buyer org)', async () => {
    const opsAdmin = await bearer(server(), 'ops.admin@sf.test');
    await insertOutboxEvent(t.buyerA, { eventType: 'test.scope' });

    const res = await request(server()).get('/ops/outbox').set('Authorization', opsAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data.every((r: { org_id: string }) => [t.buyerA, t.buyerB].includes(r.org_id))).toBe(true);
  });
});
