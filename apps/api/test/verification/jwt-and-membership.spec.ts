import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import {
  PASSWORD,
  bearer,
  insertUser,
  login,
  seedTenants,
  withDb,
  type Tenants,
} from '../helpers/identity-fixtures';

// How issued tokens and logins react when the account or its memberships change.
describe('token and membership state changes', () => {
  let app: INestApplication;
  let t: Tenants;
  const server = () => app.getHttpServer();
  const invalidCredentials = { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } };

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
  });

  it('refuses login once the organisation is deactivated', async () => {
    await withDb((pg) => pg.query(`UPDATE commerce.organizations SET is_active = false WHERE id = $1`, [t.buyerA]));
    const r = await login(server(), 'buyer@a.test');
    expect(r.status).toBe(401);
    expect(r.body).toEqual(invalidCredentials);
  });

  it('refuses login for an account with no memberships', async () => {
    await withDb((pg) => pg.query('DELETE FROM commerce.org_members WHERE user_id = $1', [t.users.buyerA]));
    const r = await login(server(), 'buyer@a.test');
    expect(r.status).toBe(401);
    expect(r.body).toEqual(invalidCredentials);
  });

  it('a multi-org account cannot choose its inactive organisation, but can use the active one', async () => {
    await withDb(async (pg) => {
      await insertUser(pg, {
        email: 'multi@x.test',
        memberships: [
          { orgId: t.buyerA, orgType: 'buyer', role: 'buyer' },
          { orgId: t.buyerB, orgType: 'buyer', role: 'buyer' },
        ],
      });
      await pg.query('UPDATE commerce.organizations SET is_active = false WHERE id = $1', [t.buyerA]);
    });

    expect((await login(server(), 'multi@x.test', PASSWORD, 'BUYER-A')).status).toBe(401);

    // With only one active organisation left, no org_code is needed.
    const r = await login(server(), 'multi@x.test');
    expect(r.status).toBe(200);
    expect(r.body.data.acting_as.org_code).toBe('BUYER-B');
  });

  it('/auth/me rejects a still-valid token once the membership is gone', async () => {
    const auth = await bearer(server(), 'buyer@a.test');
    await withDb((pg) => pg.query('DELETE FROM commerce.org_members WHERE user_id = $1', [t.users.buyerA]));
    const res = await request(server()).get('/auth/me').set('Authorization', auth);
    expect(res.status).toBe(401);
  });

  // Documented trade-off (docs/adr/0009): access tokens are stateless for their
  // 15-minute lifetime. A demoted admin keeps admin routes until the token expires;
  // the next refresh issues a token with the new role.
  it('a demoted admin keeps the old role until the access token is refreshed', async () => {
    const r = await login(server(), 'admin@a.test');
    const auth = `Bearer ${r.accessToken}`;
    await withDb((pg) => pg.query(`UPDATE commerce.org_members SET role = 'buyer' WHERE user_id = $1`, [t.users.adminA]));

    expect((await request(server()).get('/users').set('Authorization', auth)).status).toBe(200);

    const refreshed = await request(server()).post('/auth/refresh').set('Cookie', r.refreshCookie);
    expect(refreshed.body.data.acting_as.role).toBe('buyer');
    const newAuth = `Bearer ${refreshed.body.data.access_token}`;
    expect((await request(server()).get('/users').set('Authorization', newAuth)).status).toBe(403);
  });
});
