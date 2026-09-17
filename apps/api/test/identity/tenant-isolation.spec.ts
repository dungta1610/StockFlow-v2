import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import { bearer, seedTenants, type Tenants } from '../helpers/identity-fixtures';

describe('tenant isolation', () => {
  let app: INestApplication;
  let t: Tenants;
  const server = () => app.getHttpServer();
  const get = async (path: string, email: string) =>
    request(server()).get(path).set('Authorization', await bearer(server(), email));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
  });

  describe('a buyer admin', () => {
    it('lists only users of their own organisation', async () => {
      const res = await get('/users', 'admin@a.test');
      expect(res.status).toBe(200);
      const emails = res.body.data.map((u: { email: string }) => u.email).sort();
      expect(emails).toEqual(['admin@a.test', 'buyer@a.test']);
      for (const u of res.body.data) {
        expect(u.memberships.map((m: { org_id: string }) => m.org_id)).toEqual([t.buyerA]);
      }
    });

    it('gets 404 — not 403 — for a user of another organisation', async () => {
      const res = await get(`/users/${t.users.buyerB}`, 'admin@a.test');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('gets 404 for an ops user of the internal organisation', async () => {
      expect((await get(`/users/${t.users.opsAdmin}`, 'admin@a.test')).status).toBe(404);
    });

    it('cannot filter their way into another organisation', async () => {
      const res = await get(`/users?org_id=${t.buyerB}`, 'admin@a.test');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('cannot update a user of another organisation', async () => {
      const res = await request(server())
        .put(`/users/${t.users.buyerB}`)
        .set('Authorization', await bearer(server(), 'admin@a.test'))
        .send({ full_name: 'Hijacked', role: 'buyer' });
      expect(res.status).toBe(404);
    });

    it('cannot create a user inside another organisation', async () => {
      const res = await request(server())
        .post('/users')
        .set('Authorization', await bearer(server(), 'admin@a.test'))
        .send({ email: 'plant@b.test', password: 'password-123', full_name: 'Plant', org_id: t.buyerB, role: 'buyer' });
      expect(res.status).toBe(404);
    });

    it('sees only their own organisation', async () => {
      const list = await get('/organizations', 'admin@a.test');
      expect(list.body.data.map((o: { id: string }) => o.id)).toEqual([t.buyerA]);
      expect((await get(`/organizations/${t.buyerB}`, 'admin@a.test')).status).toBe(404);
      expect((await get(`/organizations/${t.internal}`, 'admin@a.test')).status).toBe(404);
    });
  });

  describe('internal ops staff', () => {
    it('ops_admin lists users of every organisation, internal included', async () => {
      const res = await get('/users?limit=100', 'ops.admin@sf.test');
      const emails = res.body.data.map((u: { email: string }) => u.email).sort();
      expect(emails).toEqual([
        'admin@a.test',
        'admin@b.test',
        'buyer@a.test',
        'buyer@b.test',
        'ops.admin@sf.test',
        'ops@sf.test',
      ]);
    });

    it('ops_admin reads a user of any buyer organisation', async () => {
      const res = await get(`/users/${t.users.buyerB}`, 'ops.admin@sf.test');
      expect(res.status).toBe(200);
      expect(res.body.data.memberships[0]).toMatchObject({ org_id: t.buyerB, org_code: 'BUYER-B' });
    });

    it('ops (non-admin) can see every organisation', async () => {
      const res = await get('/organizations', 'ops@sf.test');
      expect(res.body.data.map((o: { code: string }) => o.code).sort()).toEqual(['BUYER-A', 'BUYER-B', 'INTERNAL']);
      expect((await get(`/organizations/${t.buyerB}`, 'ops@sf.test')).status).toBe(200);
    });
  });
});
