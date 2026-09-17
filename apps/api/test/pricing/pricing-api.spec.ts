import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { insertPriceList, insertProduct, insertTier } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('pricing API', () => {
  let app: INestApplication;
  let t: Tenants;
  let opsAdmin: string;
  let ops: string;
  let buyerA: string;
  let paper: string;
  let pen: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    [opsAdmin, ops, buyerA] = await Promise.all([
      bearer(server(), 'ops.admin@sf.test'),
      bearer(server(), 'ops@sf.test'),
      bearer(server(), 'buyer@a.test'),
    ]);
    await withDb(async (pg) => {
      paper = await insertProduct(pg, { sku: 'PAPER', basePrice: '60000' });
      pen = await insertProduct(pg, { sku: 'PEN', basePrice: '5000' });
    });
  });

  describe('/price-lists', () => {
    const createList = (body: object, auth = opsAdmin) =>
      request(server()).post('/price-lists').set('Authorization', auth).send(body);

    it('ops_admin creates a contract list for a buyer and adds tiers', async () => {
      const list = await createList({ org_id: t.buyerA, name: 'Hợp đồng A', valid_from: '2026-01-01T00:00:00Z', priority: 5 });
      expect(list.status).toBe(201);
      expect(list.body.data).toMatchObject({ org_id: t.buyerA, priority: 5, status: 'active', valid_to: null, currency: 'VND' });

      const items = await request(server())
        .post(`/price-lists/${list.body.data.id}/items`)
        .set('Authorization', opsAdmin)
        .send({ items: [
          { product_id: paper, unit_price: '48000' },
          { product_id: paper, min_qty: 50, unit_price: '45000.5' },
        ] });
      expect(items.status).toBe(200);
      expect(items.body.data.items).toEqual([
        expect.objectContaining({ sku: 'PAPER', min_qty: 1, unit_price: '48000.00' }),
        expect.objectContaining({ sku: 'PAPER', min_qty: 50, unit_price: '45000.50' }),
      ]);
    });

    it('re-posting a tier replaces its price instead of duplicating it', async () => {
      const list = await createList({ name: 'Default', valid_from: '2026-01-01T00:00:00Z' });
      const post = (unit_price: string) =>
        request(server())
          .post(`/price-lists/${list.body.data.id}/items`)
          .set('Authorization', opsAdmin)
          .send({ items: [{ product_id: pen, unit_price }] });
      await post('4000');
      const res = await post('3500');
      expect(res.body.data.items).toEqual([expect.objectContaining({ min_qty: 1, unit_price: '3500.00' })]);
    });

    it('rejects the same tier twice in one request', async () => {
      const list = await createList({ name: 'Default', valid_from: '2026-01-01T00:00:00Z' });
      const res = await request(server())
        .post(`/price-lists/${list.body.data.id}/items`)
        .set('Authorization', opsAdmin)
        .send({ items: [{ product_id: pen, unit_price: '1' }, { product_id: pen.toUpperCase(), min_qty: 1, unit_price: '2' }] });
      expect(res.status).toBe(400);
    });

    it('accepts product ids in upper case when adding tiers', async () => {
      const list = await createList({ name: 'Default', valid_from: '2026-01-01T00:00:00Z' });
      const res = await request(server())
        .post(`/price-lists/${list.body.data.id}/items`)
        .set('Authorization', opsAdmin)
        .send({ items: [{ product_id: pen.toUpperCase(), unit_price: '4000' }] });
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([expect.objectContaining({ product_id: pen, sku: 'PEN' })]);
    });

    it('refuses a contract list for the internal organisation', async () => {
      const res = await createList({ org_id: t.internal, name: 'x', valid_from: '2026-01-01T00:00:00Z' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CUSTOMER_NOT_BUYER');
    });

    it('404s for an unknown organisation or product', async () => {
      const noOrg = await createList({ org_id: '00000000-0000-4000-8000-000000000000', name: 'x', valid_from: '2026-01-01T00:00:00Z' });
      expect(noOrg.status).toBe(404);

      const list = await createList({ name: 'x', valid_from: '2026-01-01T00:00:00Z' });
      const noProduct = await request(server())
        .post(`/price-lists/${list.body.data.id}/items`)
        .set('Authorization', opsAdmin)
        .send({ items: [{ product_id: '00000000-0000-4000-8000-000000000000', unit_price: '1' }] });
      expect(noProduct.status).toBe(404);
      expect(noProduct.body.error.code).toBe('PRODUCT_NOT_FOUND');
    });

    it('rejects a validity window that ends before it starts', async () => {
      const res = await createList({ name: 'x', valid_from: '2026-02-01T00:00:00Z', valid_to: '2026-01-01T00:00:00Z' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_VALIDITY');
    });

    it('archives a list, which then cannot be changed', async () => {
      const list = await createList({ name: 'x', valid_from: '2026-01-01T00:00:00Z' });
      const archived = await request(server()).post(`/price-lists/${list.body.data.id}/archive`).set('Authorization', opsAdmin);
      expect(archived.body.data.status).toBe('archived');
      const change = await request(server())
        .post(`/price-lists/${list.body.data.id}/items`)
        .set('Authorization', opsAdmin)
        .send({ items: [{ product_id: pen, unit_price: '1' }] });
      expect(change.status).toBe(409);
      expect(change.body.error.code).toBe('PRICE_LIST_ARCHIVED');
    });

    it('lists and reads lists for ops, filtered by customer', async () => {
      await createList({ org_id: t.buyerA, name: 'A', valid_from: '2026-01-01T00:00:00Z' });
      await createList({ org_id: t.buyerB, name: 'B', valid_from: '2026-01-01T00:00:00Z' });
      await createList({ name: 'Default', valid_from: '2026-01-01T00:00:00Z' });

      const all = await request(server()).get('/price-lists').set('Authorization', ops);
      expect(all.body.data).toHaveLength(3);
      const onlyA = await request(server()).get(`/price-lists?org_id=${t.buyerA}`).set('Authorization', ops);
      expect(onlyA.body.data.map((l: { name: string }) => l.name)).toEqual(['A']);

      const one = await request(server()).get(`/price-lists/${onlyA.body.data[0].id}`).set('Authorization', ops);
      expect(one.body.data).toMatchObject({ name: 'A', items: [] });
    });

    it('is closed to buyers entirely, and writes are closed to plain ops', async () => {
      expect((await request(server()).get('/price-lists').set('Authorization', buyerA)).status).toBe(403);
      expect((await createList({ name: 'x', valid_from: '2026-01-01T00:00:00Z' }, ops)).status).toBe(403);
      expect((await createList({ name: 'x', valid_from: '2026-01-01T00:00:00Z' }, buyerA)).status).toBe(403);
    });
  });

  describe('POST /pricing/quote', () => {
    beforeEach(async () => {
      await withDb(async (pg) => {
        const defaults = await insertPriceList(pg, { name: 'default' });
        const contractA = await insertPriceList(pg, { orgId: t.buyerA, name: 'A' });
        const contractB = await insertPriceList(pg, { orgId: t.buyerB, name: 'B' });
        await insertTier(pg, { listId: defaults, productId: paper, unitPrice: '55000' });
        await insertTier(pg, { listId: contractA, productId: paper, unitPrice: '50000' });
        await insertTier(pg, { listId: contractA, productId: paper, minQty: 10, unitPrice: '47500.50' });
        await insertTier(pg, { listId: contractB, productId: paper, unitPrice: '40000' });
      });
    });
    const quote = (body: object, auth: string) => request(server()).post('/pricing/quote').set('Authorization', auth).send(body);

    it('prices a buyer’s cart at their contract prices and explains each line', async () => {
      const res = await quote({ items: [{ product_id: paper, qty: 12 }, { product_id: pen, qty: 3 }] }, buyerA);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        customer_org_id: t.buyerA,
        currency: 'VND',
        total: '585006.00',
        lines: [
          { sku: 'PAPER', qty: 12, unit_price: '47500.50', line_total: '570006.00', source_kind: 'contract', min_qty_applied: 10 },
          { sku: 'PEN', qty: 3, unit_price: '5000.00', line_total: '15000.00', source_kind: 'base_price', source_id: null },
        ],
      });
    });

    it('never lets a buyer quote as another customer', async () => {
      const res = await quote({ customer_org_id: t.buyerB, items: [{ product_id: paper, qty: 1 }] }, buyerA);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('40000');
    });

    it('accepts a buyer naming their own organisation', async () => {
      const res = await quote({ customer_org_id: t.buyerA, items: [{ product_id: paper, qty: 1 }] }, buyerA);
      expect(res.body.data.lines[0].unit_price).toBe('50000.00');
    });

    it('ops quote for a named customer and must name one', async () => {
      const forB = await quote({ customer_org_id: t.buyerB, items: [{ product_id: paper, qty: 1 }] }, ops);
      expect(forB.body.data.lines[0].unit_price).toBe('40000.00');

      const unnamed = await quote({ items: [{ product_id: paper, qty: 1 }] }, ops);
      expect(unnamed.status).toBe(400);
      expect(unnamed.body.error.code).toBe('CUSTOMER_ORG_REQUIRED');
    });

    it('rejects duplicate products, empty carts and bad quantities', async () => {
      expect((await quote({ items: [{ product_id: pen, qty: 1 }, { product_id: pen, qty: 2 }] }, buyerA)).status).toBe(400);
      expect((await quote({ items: [] }, buyerA)).status).toBe(400);
      expect((await quote({ items: [{ product_id: pen, qty: 0 }] }, buyerA)).status).toBe(400);
      expect((await quote({ items: [{ product_id: pen, qty: 1.5 }] }, buyerA)).status).toBe(400);
    });

    it('accepts product ids in upper case', async () => {
      const res = await quote({ items: [{ product_id: paper.toUpperCase(), qty: 1 }] }, buyerA);
      expect(res.status).toBe(200);
      expect(res.body.data.lines[0]).toMatchObject({ product_id: paper, unit_price: '50000.00' });
    });

    it('treats the same product in two letter cases as a duplicate', async () => {
      const res = await quote({ items: [{ product_id: pen, qty: 1 }, { product_id: pen.toUpperCase(), qty: 1 }] }, buyerA);
      expect(res.status).toBe(400);
    });

    it('ignores any price the client tries to send', async () => {
      const res = await quote({ items: [{ product_id: paper, qty: 1, unit_price: '0' }] }, buyerA);
      expect(res.body.data.lines[0].unit_price).toBe('50000.00');
    });
  });
});
