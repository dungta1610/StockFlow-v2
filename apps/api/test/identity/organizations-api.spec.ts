import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import { bearer, seedTenants } from '../helpers/identity-fixtures';

describe('/organizations', () => {
  let app: INestApplication;
  let opsAdmin: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await seedTenants();
    opsAdmin = await bearer(server(), 'ops.admin@sf.test');
  });

  const create = (body: object) => request(server()).post('/organizations').set('Authorization', opsAdmin).send(body);

  it('creates an organisation, normalising the code to upper case', async () => {
    const res = await create({ code: '  acme-hn ', name: ' ACME Hà Nội ', type: 'buyer', tax_code: '0101234567' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      code: 'ACME-HN',
      name: 'ACME Hà Nội',
      type: 'buyer',
      tax_code: '0101234567',
      is_active: true,
    });
  });

  it('rejects a duplicate code with 409', async () => {
    const res = await create({ code: 'buyer-a', name: 'Dup', type: 'buyer' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORG_CODE_ALREADY_EXISTS');
  });

  it('rejects an unknown organisation type', async () => {
    expect((await create({ code: 'X', name: 'X', type: 'seller' })).status).toBe(400);
  });

  it('lists with paging and filters by type and code', async () => {
    const all = await request(server()).get('/organizations').set('Authorization', opsAdmin);
    expect(all.body.paging).toEqual({ page: 1, limit: 10 });
    expect(all.body.data).toHaveLength(3);

    const buyers = await request(server()).get('/organizations?type=buyer').set('Authorization', opsAdmin);
    expect(buyers.body.data.map((o: { code: string }) => o.code).sort()).toEqual(['BUYER-A', 'BUYER-B']);

    const one = await request(server()).get('/organizations?code=buyer-b').set('Authorization', opsAdmin);
    expect(one.body.data.map((o: { code: string }) => o.code)).toEqual(['BUYER-B']);
  });

  it('gets one organisation, 404 when unknown', async () => {
    const created = await create({ code: 'NEW', name: 'New', type: 'buyer' });
    const got = await request(server()).get(`/organizations/${created.body.data.id}`).set('Authorization', opsAdmin);
    expect(got.status).toBe(200);
    expect(got.body.data.code).toBe('NEW');

    const missing = await request(server())
      .get('/organizations/00000000-0000-4000-8000-000000000000')
      .set('Authorization', opsAdmin);
    expect(missing.status).toBe(404);
  });
});
