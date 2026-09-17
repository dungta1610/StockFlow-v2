import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import { bearer, insertUser, login, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';

// Behaviour carried over from StockFlow's /users module (create / get / list / update),
// now scoped to organisations and without client-supplied password hashes.
describe('/users', () => {
  let app: INestApplication;
  let t: Tenants;
  let adminA: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    adminA = await bearer(server(), 'admin@a.test');
  });

  const create = (body: object) => request(server()).post('/users').set('Authorization', adminA).send(body);

  describe('POST /users', () => {
    const valid = () => ({
      email: '  New.Person@A.test ',
      password: 'a-strong-password',
      full_name: '  New Person ',
      org_id: t.buyerA,
      role: 'buyer',
    });

    it('creates a user with 201 { data }, normalising email and name', async () => {
      const res = await create(valid());
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        email: 'new.person@a.test',
        full_name: 'New Person',
        is_active: true,
        memberships: [{ org_id: t.buyerA, org_code: 'BUYER-A', org_type: 'buyer', role: 'buyer' }],
      });
      expect(res.body.data.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('stores a hash, never the password, and never returns either', async () => {
      const res = await create(valid());
      expect(JSON.stringify(res.body)).not.toMatch(/password|a-strong-password/);
      const { rows } = await withDb((pg) =>
        pg.query('SELECT password_hash FROM commerce.users WHERE id = $1', [res.body.data.id]),
      );
      expect(rows[0].password_hash.startsWith('$argon2id$')).toBe(true);
      expect((await login(server(), 'new.person@a.test', 'a-strong-password')).status).toBe(200);
    });

    it('rejects a duplicate email case-insensitively with 409', async () => {
      const res = await create({ ...valid(), email: 'BUYER@A.TEST' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('rejects a weak password', async () => {
      const res = await create({ ...valid(), password: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WEAK_PASSWORD');
    });

    it('requires email, password, full_name, org_id and role (as StockFlow required its fields)', async () => {
      const res = await create({});
      expect(res.status).toBe(400);
      const paths = res.body.error.details.map((d: { path: string }) => d.path).sort();
      expect(paths).toEqual(['email', 'full_name', 'org_id', 'password', 'role']);
    });

    it('rejects a blank full name after trimming', async () => {
      expect((await create({ ...valid(), full_name: '   ' })).status).toBe(400);
    });

    it('does not create the user when the membership is rejected', async () => {
      await create({ ...valid(), role: 'ops' });
      const { rows } = await withDb((pg) => pg.query(`SELECT 1 FROM commerce.users WHERE email = 'new.person@a.test'`));
      expect(rows).toHaveLength(0);
    });
  });

  describe('GET /users', () => {
    beforeEach(async () => {
      await withDb(async (pg) => {
        for (let i = 1; i <= 12; i++) {
          await insertUser(pg, {
            email: `staff${String(i).padStart(2, '0')}@a.test`,
            fullName: i % 2 ? `Nguyễn Văn ${i}` : `Trần Thị ${i}`,
            isActive: i !== 12,
            memberships: [{ orgId: t.buyerA, orgType: 'buyer', role: 'buyer' }],
          });
        }
      });
    });

    const list = (qs = '') => request(server()).get(`/users${qs}`).set('Authorization', adminA);

    it('pages with StockFlow defaults: page 1, limit 10, and echoes { page, limit }', async () => {
      const res = await list();
      expect(res.status).toBe(200);
      expect(res.body.paging).toEqual({ page: 1, limit: 10 });
      expect(res.body.data).toHaveLength(10);

      const page2 = await list('?page=2&limit=10');
      expect(page2.body.data).toHaveLength(4); // 14 users in org A
      const ids = new Set([...res.body.data, ...page2.body.data].map((u: { id: string }) => u.id));
      expect(ids.size).toBe(14);
    });

    it('normalises out-of-range paging like StockFlow did', async () => {
      expect((await list('?page=0&limit=0')).body.paging).toEqual({ page: 1, limit: 10 });
      expect((await list('?limit=500')).body.paging).toEqual({ page: 1, limit: 100 });
    });

    it('rejects a non-numeric page or limit with 400', async () => {
      expect((await list('?page=abc')).status).toBe(400);
      expect((await list('?limit=ten')).status).toBe(400);
    });

    it('filters by exact email, case-insensitively', async () => {
      const res = await list('?email=STAFF03@a.test');
      expect(res.body.data.map((u: { email: string }) => u.email)).toEqual(['staff03@a.test']);
    });

    it('filters by partial, case-insensitive full name', async () => {
      const res = await list('?full_name=nguyễn&limit=100');
      expect(res.body.data).toHaveLength(6);
    });

    it('filters by role and by is_active', async () => {
      const admins = await list('?role=buyer_admin');
      expect(admins.body.data.map((u: { email: string }) => u.email)).toEqual(['admin@a.test']);

      const inactive = await list('?is_active=false');
      expect(inactive.body.data.map((u: { email: string }) => u.email)).toEqual(['staff12@a.test']);
    });

    it('rejects an invalid is_active value', async () => {
      expect((await list('?is_active=maybe')).status).toBe(400);
    });

    it('orders newest first', async () => {
      const res = await list('?limit=100');
      const created = res.body.data.map((u: { created_at: string }) => Date.parse(u.created_at));
      expect(created).toEqual([...created].sort((a, b) => b - a));
    });
  });

  describe('GET /users/:id', () => {
    it('returns the user', async () => {
      const res = await request(server()).get(`/users/${t.users.buyerA}`).set('Authorization', adminA);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: t.users.buyerA, email: 'buyer@a.test' });
    });

    it('returns 404 for an unknown id and 400 for a malformed one', async () => {
      const missing = await request(server())
        .get('/users/00000000-0000-4000-8000-000000000000')
        .set('Authorization', adminA);
      expect(missing.status).toBe(404);
      expect((await request(server()).get('/users/not-a-uuid').set('Authorization', adminA)).status).toBe(400);
    });
  });

  describe('PUT /users/:id', () => {
    const update = (id: string, body: object, auth = adminA) =>
      request(server()).put(`/users/${id}`).set('Authorization', auth).send(body);

    it('updates full name and role', async () => {
      const res = await update(t.users.buyerA, { full_name: '  Renamed  ', role: 'buyer_admin' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ full_name: 'Renamed', memberships: [{ role: 'buyer_admin' }] });
    });

    it('requires full_name and role, as StockFlow did', async () => {
      const res = await update(t.users.buyerA, { is_active: false });
      expect(res.status).toBe(400);
    });

    it('changes the password when one is given', async () => {
      await update(t.users.buyerA, { full_name: 'Buyer A', role: 'buyer', password: 'brand-new-password' });
      expect((await login(server(), 'buyer@a.test', 'brand-new-password')).status).toBe(200);
      expect((await login(server(), 'buyer@a.test')).status).toBe(401);
    });

    it('deactivates a user, who then cannot log in', async () => {
      const res = await update(t.users.buyerA, { full_name: 'Buyer A', role: 'buyer', is_active: false });
      expect(res.body.data.is_active).toBe(false);
      expect((await login(server(), 'buyer@a.test')).status).toBe(401);
    });

    it('bumps updated_at', async () => {
      const before = (await request(server()).get(`/users/${t.users.buyerA}`).set('Authorization', adminA)).body.data;
      await new Promise((r) => setTimeout(r, 20));
      const after = (await update(t.users.buyerA, { full_name: 'Buyer A2', role: 'buyer' })).body.data;
      expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(before.updated_at));
    });

    it('returns 404 for an unknown user', async () => {
      expect((await update('00000000-0000-4000-8000-000000000000', { full_name: 'X', role: 'buyer' })).status).toBe(404);
    });

    describe('user with memberships in several organisations', () => {
      let multi: string;
      beforeEach(async () => {
        multi = await withDb((pg) =>
          insertUser(pg, {
            email: 'multi@x.test',
            memberships: [
              { orgId: t.buyerA, orgType: 'buyer', role: 'buyer' },
              { orgId: t.buyerB, orgType: 'buyer', role: 'buyer' },
            ],
          }),
        );
      });

      it('a buyer admin changes only the membership in their own organisation', async () => {
        // full_name unchanged: account-level fields are not being modified.
        const res = await update(multi, { full_name: 'multi@x.test', role: 'buyer_admin' });
        expect(res.status).toBe(200);
        expect(res.body.data.memberships).toEqual([expect.objectContaining({ org_id: t.buyerA, role: 'buyer_admin' })]);
        const { rows } = await withDb((pg) =>
          pg.query('SELECT role FROM commerce.org_members WHERE user_id = $1 AND org_id = $2', [multi, t.buyerB]),
        );
        expect(rows[0].role).toBe('buyer');
      });

      it('filtering by organisation still shows every membership in scope', async () => {
        const ops = await bearer(server(), 'ops.admin@sf.test');
        const res = await request(server())
          .get(`/users?org_id=${t.buyerA}&email=multi@x.test`)
          .set('Authorization', ops);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].memberships.map((m: { org_code: string }) => m.org_code)).toEqual([
          'BUYER-A',
          'BUYER-B',
        ]);
      });

      it('ops_admin must say which membership to change', async () => {
        const ops = await bearer(server(), 'ops.admin@sf.test');
        const vague = await update(multi, { full_name: 'Multi', role: 'buyer_admin' }, ops);
        expect(vague.status).toBe(400);
        expect(vague.body.error.code).toBe('ORG_ID_REQUIRED');

        const precise = await update(multi, { full_name: 'Multi', role: 'buyer_admin', org_id: t.buyerB }, ops);
        expect(precise.status).toBe(200);
      });

      // Account-level fields affect every organisation the user belongs to. Letting
      // org A's admin reset the password of an account shared with org B would be a
      // cross-tenant account takeover.
      it('a buyer admin cannot change account-level fields of a user shared with another organisation', async () => {
        const base = { full_name: 'multi@x.test', role: 'buyer' };
        for (const change of [{ is_active: false }, { password: 'takeover-password' }, { full_name: 'Renamed' }]) {
          const res = await update(multi, { ...base, ...change });
          expect(res.status).toBe(403);
        }
        expect((await login(server(), 'multi@x.test', 'takeover-password', 'BUYER-B')).status).toBe(401);
      });

      it('ops_admin can change account-level fields of a shared user', async () => {
        const ops = await bearer(server(), 'ops.admin@sf.test');
        const res = await update(multi, { full_name: 'Renamed', role: 'buyer', org_id: t.buyerA, is_active: false }, ops);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ full_name: 'Renamed', is_active: false });
      });
    });
  });
});
