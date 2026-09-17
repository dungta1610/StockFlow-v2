import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import { bearer, insertOrg, insertUser, seedTenants, withDb } from '../helpers/identity-fixtures';

// If a buyer admin could give someone in their organisation an `ops` role, that
// person would pass every ops-only guard. The rule is enforced in the database,
// not only in application code.
describe('role must match organisation type', () => {
  it('the database refuses an ops role inside a buyer organisation', async () => {
    await withDb(async (pg) => {
      const buyer = await insertOrg(pg, { code: 'B1', type: 'buyer' });
      await expect(
        insertUser(pg, { email: 'x@b1.test', memberships: [{ orgId: buyer, orgType: 'buyer', role: 'ops' }] }),
      ).rejects.toThrow(/chk_role_matches_org_type/);
    });
  });

  it('the database refuses a buyer role inside the internal organisation', async () => {
    await withDb(async (pg) => {
      const internal = await insertOrg(pg, { code: 'I1', type: 'internal' });
      await expect(
        insertUser(pg, {
          email: 'y@i1.test',
          memberships: [{ orgId: internal, orgType: 'internal', role: 'buyer_admin' }],
        }),
      ).rejects.toThrow(/chk_role_matches_org_type/);
    });
  });

  it('the database refuses a membership that lies about its organisation type', async () => {
    await withDb(async (pg) => {
      const buyer = await insertOrg(pg, { code: 'B2', type: 'buyer' });
      // Claims the buyer org is internal to smuggle in an ops role.
      await expect(
        insertUser(pg, { email: 'z@b2.test', memberships: [{ orgId: buyer, orgType: 'internal', role: 'ops' }] }),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  describe('through the API', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await createTestApp();
    });
    afterAll(() => app.close());

    it('a buyer admin cannot create an ops user in their organisation', async () => {
      const t = await seedTenants();
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', await bearer(app.getHttpServer(), 'admin@a.test'))
        .send({ email: 'mole@a.test', password: 'password-123', full_name: 'Mole', org_id: t.buyerA, role: 'ops' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ROLE_NOT_ALLOWED_FOR_ORG');
    });

    it('a buyer admin cannot promote an existing user to ops', async () => {
      const t = await seedTenants();
      const res = await request(app.getHttpServer())
        .put(`/users/${t.users.buyerA}`)
        .set('Authorization', await bearer(app.getHttpServer(), 'admin@a.test'))
        .send({ full_name: 'Buyer A', role: 'ops_admin' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ROLE_NOT_ALLOWED_FOR_ORG');
    });
  });
});
