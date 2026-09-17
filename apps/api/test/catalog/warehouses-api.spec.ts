import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CatalogService } from '../../src/modules/catalog/application/catalog.service';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

// StockFlow /warehouses behaviour (create, get, list) plus update.
describe('/warehouses', () => {
  let app: INestApplication;
  let opsAdmin: string;
  let buyer: string;
  const server = () => app.getHttpServer();
  const create = (body: object, auth = opsAdmin) =>
    request(server()).post('/warehouses').set('Authorization', auth).send(body);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await seedTenants();
    opsAdmin = await bearer(server(), 'ops.admin@sf.test');
    buyer = await bearer(server(), 'buyer@a.test');
  });

  it('creates a warehouse, normalising code, name and address', async () => {
    const res = await create({ code: ' hn-01 ', name: ' Kho Hà Nội ', address: ' Long Biên ' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'HN-01', name: 'Kho Hà Nội', address: 'Long Biên', is_active: true });
  });

  it('rejects a duplicate code with 409 and missing fields with 400', async () => {
    await create({ code: 'HN-01', name: 'A' });
    const dup = await create({ code: 'hn-01', name: 'B' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WAREHOUSE_CODE_ALREADY_EXISTS');
    expect((await create({ code: 'X' })).status).toBe(400);
  });

  it('is written only by ops_admin but readable by anyone signed in', async () => {
    expect((await create({ code: 'B1', name: 'B' }, buyer)).status).toBe(403);
    const created = await create({ code: 'R1', name: 'R' });
    const res = await request(server()).get(`/warehouses/${created.body.data.id}`).set('Authorization', buyer);
    expect(res.status).toBe(200);
  });

  it('lists with paging and filters by code, name and is_active', async () => {
    await withDb(async (pg) => {
      await insertWarehouse(pg, { code: 'HN-01', name: 'Kho Hà Nội' });
      await insertWarehouse(pg, { code: 'HCM-01', name: 'Kho Sài Gòn', isActive: false });
    });
    const list = (qs: string) => request(server()).get(`/warehouses${qs}`).set('Authorization', buyer);
    expect((await list('')).body.paging).toEqual({ page: 1, limit: 10 });
    expect((await list('?code=hn-01')).body.data.map((w: { code: string }) => w.code)).toEqual(['HN-01']);
    expect((await list('?name=sài')).body.data.map((w: { code: string }) => w.code)).toEqual(['HCM-01']);
    expect((await list('?is_active=true')).body.data.map((w: { code: string }) => w.code)).toEqual(['HN-01']);
  });

  it('updates name, address and activation but never the code', async () => {
    const { body } = await create({ code: 'UP-1', name: 'Old' });
    const res = await request(server())
      .put(`/warehouses/${body.data.id}`)
      .set('Authorization', opsAdmin)
      .send({ code: 'HIJACK', name: 'New', address: 'Addr', is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ code: 'UP-1', name: 'New', address: 'Addr', is_active: false });
  });

  it('404s for an unknown warehouse', async () => {
    const res = await request(server())
      .get('/warehouses/00000000-0000-4000-8000-000000000000')
      .set('Authorization', buyer);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WAREHOUSE_NOT_FOUND');
  });
});

// Lookups by business code — what agent tools and later phases use.
describe('CatalogService lookups by code', () => {
  let app: INestApplication;
  let catalog: CatalogService;
  let uow: UnitOfWork;

  beforeAll(async () => {
    app = await createTestApp();
    catalog = app.get(CatalogService);
    uow = app.get(UnitOfWork);
  });
  afterAll(() => app.close());

  it('finds a product by SKU and a warehouse by code, case-insensitively', async () => {
    await withDb(async (pg) => {
      await insertProduct(pg, { sku: 'ABC-1', basePrice: '5' });
      await insertWarehouse(pg, { code: 'WH-1' });
    });
    expect((await catalog.findProductBySku(uow.db, ' abc-1 '))?.sku).toBe('ABC-1');
    expect((await catalog.findWarehouseByCode(uow.db, 'wh-1'))?.code).toBe('WH-1');
  });

  it('returns null — not an error — when nothing matches', async () => {
    expect(await catalog.findProductBySku(uow.db, 'NOPE')).toBeNull();
    expect(await catalog.findWarehouseByCode(uow.db, 'NOPE')).toBeNull();
  });
});
