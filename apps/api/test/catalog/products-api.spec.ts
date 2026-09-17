import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { insertProduct } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

// StockFlow /products behaviour (create, get, list) plus update, with money as
// decimal strings instead of floats.
describe('/products', () => {
  let app: INestApplication;
  let opsAdmin: string;
  let buyer: string;
  const server = () => app.getHttpServer();
  const create = (body: object, auth = opsAdmin) =>
    request(server()).post('/products').set('Authorization', auth).send(body);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await seedTenants();
    opsAdmin = await bearer(server(), 'ops.admin@sf.test');
    buyer = await bearer(server(), 'buyer@a.test');
  });

  describe('POST /products', () => {
    const valid = { sku: ' tp-001 ', name: ' Giấy A4 ', description: '  70gsm ', base_price: '65000.5' };

    it('creates a product with 201 { data }, normalising sku, name and description', async () => {
      const res = await create(valid);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        sku: 'TP-001',
        name: 'Giấy A4',
        description: '70gsm',
        base_price: '65000.50',
        currency: 'VND',
        uom: 'each',
        is_active: true,
      });
    });

    it('returns money as a string, never a JSON number', async () => {
      const res = await create(valid);
      expect(typeof res.body.data.base_price).toBe('string');
      expect(res.text).toContain('"base_price":"65000.50"');
    });

    it.each([65000.5, '65,000', '1.005', '-1'])('rejects base_price %j', async (base_price) => {
      const res = await create({ ...valid, base_price });
      expect(res.status).toBe(400);
    });

    it('rejects a duplicate SKU case-insensitively with 409', async () => {
      await create(valid);
      const res = await create({ ...valid, sku: 'TP-001' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SKU_ALREADY_EXISTS');
    });

    it('requires sku, name and base_price, as StockFlow did (sku, name, price)', async () => {
      const res = await create({});
      const paths = res.body.error.details.map((d: { path: string }) => d.path).sort();
      expect(paths).toEqual(['base_price', 'name', 'sku']);
    });

    it('is reserved for ops_admin', async () => {
      expect((await create(valid, buyer)).status).toBe(403);
      expect((await create(valid, await bearer(server(), 'ops@sf.test'))).status).toBe(403);
    });
  });

  describe('GET /products', () => {
    beforeEach(async () => {
      await withDb(async (pg) => {
        for (let i = 1; i <= 12; i++) {
          await insertProduct(pg, {
            sku: `SKU-${String(i).padStart(2, '0')}`,
            name: i % 2 ? `Bút bi ${i}` : `Giấy ${i}`,
            basePrice: '1000',
            isActive: i !== 12,
          });
        }
      });
    });
    const list = (qs = '', auth = buyer) => request(server()).get(`/products${qs}`).set('Authorization', auth);

    it('is readable by any signed-in user, with StockFlow paging', async () => {
      const res = await list();
      expect(res.status).toBe(200);
      expect(res.body.paging).toEqual({ page: 1, limit: 10 });
      expect(res.body.data).toHaveLength(10);
      expect((await list('?page=2')).body.data).toHaveLength(1); // SKU-12 is inactive
    });

    it('filters by exact SKU (case-insensitive), partial name and is_active', async () => {
      expect((await list('?sku=sku-03')).body.data.map((p: { sku: string }) => p.sku)).toEqual(['SKU-03']);
      expect((await list('?name=bút&limit=100')).body.data).toHaveLength(6);
      expect((await list('?is_active=false', opsAdmin)).body.data.map((p: { sku: string }) => p.sku)).toEqual(['SKU-12']);
      expect((await list('?limit=100', opsAdmin)).body.data).toHaveLength(12);
    });

    it('hides discontinued products from buyers', async () => {
      expect((await list('?limit=100')).body.data).toHaveLength(11);
      expect((await list('?is_active=false')).body.data).toEqual([]);
      const [id] = await withDb(async (pg) =>
        (await pg.query(`SELECT id FROM commerce.products WHERE sku = 'SKU-12'`)).rows.map((r) => r.id),
      );
      const asBuyer = await request(server()).get(`/products/${id}`).set('Authorization', buyer);
      expect(asBuyer.status).toBe(404);
      expect((await request(server()).get(`/products/${id}`).set('Authorization', opsAdmin)).status).toBe(200);
    });

    it('treats LIKE wildcards in the name filter literally', async () => {
      expect((await list('?name=%25')).body.data).toEqual([]);
    });

    it('requires authentication', async () => {
      expect((await request(server()).get('/products')).status).toBe(401);
    });
  });

  describe('GET /products/:id', () => {
    it('returns the product, 404 when unknown, 400 when malformed', async () => {
      const created = await create({ sku: 'X1', name: 'X', base_price: '1' });
      const get = (id: string) => request(server()).get(`/products/${id}`).set('Authorization', buyer);
      expect((await get(created.body.data.id)).body.data.sku).toBe('X1');
      const missing = await get('00000000-0000-4000-8000-000000000000');
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('PRODUCT_NOT_FOUND');
      expect((await get('nope')).status).toBe(400);
    });
  });

  describe('PUT /products/:id', () => {
    it('updates name, description, price and activation but never the SKU', async () => {
      const { body } = await create({ sku: 'UPD', name: 'Old', base_price: '10' });
      const res = await request(server())
        .put(`/products/${body.data.id}`)
        .set('Authorization', opsAdmin)
        .send({ sku: 'HIJACK', name: ' New ', description: 'd', base_price: '12.30', is_active: false });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        sku: 'UPD',
        name: 'New',
        description: 'd',
        base_price: '12.30',
        is_active: false,
      });
      expect(Date.parse(res.body.data.updated_at)).toBeGreaterThanOrEqual(Date.parse(body.data.updated_at));
    });

    it('requires name and base_price', async () => {
      const { body } = await create({ sku: 'UPD2', name: 'Old', base_price: '10' });
      const res = await request(server()).put(`/products/${body.data.id}`).set('Authorization', opsAdmin).send({});
      expect(res.status).toBe(400);
    });

    it('is reserved for ops_admin and 404s for unknown ids', async () => {
      const { body } = await create({ sku: 'UPD3', name: 'Old', base_price: '10' });
      const payload = { name: 'X', base_price: '1' };
      expect((await request(server()).put(`/products/${body.data.id}`).set('Authorization', buyer).send(payload)).status).toBe(403);
      expect(
        (await request(server())
          .put('/products/00000000-0000-4000-8000-000000000000')
          .set('Authorization', opsAdmin)
          .send(payload)).status,
      ).toBe(404);
    });
  });
});
