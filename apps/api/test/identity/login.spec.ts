import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import { PASSWORD, insertOrg, insertUser, login, seedTenants, withDb } from '../helpers/identity-fixtures';

describe('POST /auth/login', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('returns an access token, the acting membership and a hardened refresh cookie', async () => {
    const t = await seedTenants();
    const r = await login(server(), 'buyer@a.test');

    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      user: { id: t.users.buyerA, email: 'buyer@a.test', is_active: true },
      acting_as: { org_id: t.buyerA, org_code: 'BUYER-A', org_type: 'buyer', role: 'buyer' },
    });
    expect(r.accessToken.split('.')).toHaveLength(3);

    expect(r.refreshCookie).toMatch(/^sf_refresh=.{20,}/);
    expect(r.setCookie).toMatch(/HttpOnly/i);
    expect(r.setCookie).toMatch(/Secure/i);
    expect(r.setCookie).toMatch(/SameSite=Strict/i);
    expect(r.setCookie).toMatch(/Path=\/auth/i);
  });

  it('accepts the email in any case and with surrounding spaces', async () => {
    await seedTenants();
    expect((await login(server(), '  BUYER@A.test ')).status).toBe(200);
  });

  it('never returns the password hash', async () => {
    await seedTenants();
    const r = await login(server(), 'buyer@a.test');
    expect(JSON.stringify(r.body)).not.toMatch(/password|argon2/i);
  });

  it('gives the same answer for an unknown email, a wrong password and an inactive user', async () => {
    await seedTenants();
    await withDb(async (pg) => {
      const org = await insertOrg(pg, { code: 'BUYER-X', type: 'buyer' });
      await insertUser(pg, {
        email: 'inactive@x.test',
        isActive: false,
        memberships: [{ orgId: org, orgType: 'buyer', role: 'buyer' }],
      });
    });

    const unknown = await login(server(), 'nobody@a.test');
    const wrong = await login(server(), 'buyer@a.test', 'wrong-password');
    const inactive = await login(server(), 'inactive@x.test');

    for (const r of [unknown, wrong, inactive]) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
      });
      expect(r.refreshCookie).toBe('');
    }
  });

  it('rejects a login whose only organisation is inactive', async () => {
    await withDb(async (pg) => {
      const org = await insertOrg(pg, { code: 'CLOSED', type: 'buyer', isActive: false });
      await insertUser(pg, { email: 'u@closed.test', memberships: [{ orgId: org, orgType: 'buyer', role: 'buyer' }] });
    });
    const r = await login(server(), 'u@closed.test');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  describe('account in several organisations', () => {
    let orgA: string;
    let orgB: string;

    beforeEach(async () => {
      await withDb(async (pg) => {
        orgA = await insertOrg(pg, { code: 'DIST-A', type: 'buyer' });
        orgB = await insertOrg(pg, { code: 'DIST-B', type: 'buyer' });
        await insertUser(pg, {
          email: 'distributor@d.test',
          memberships: [
            { orgId: orgA, orgType: 'buyer', role: 'buyer' },
            { orgId: orgB, orgType: 'buyer', role: 'buyer_admin' },
          ],
        });
      });
    });

    it('asks which organisation to act for, listing the choices', async () => {
      const r = await login(server(), 'distributor@d.test');
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('ORG_SELECTION_REQUIRED');
      expect(r.body.error.details.org_codes.sort()).toEqual(['DIST-A', 'DIST-B']);
    });

    it('does not reveal the organisation list without the right password', async () => {
      const r = await login(server(), 'distributor@d.test', 'wrong-password');
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.body)).not.toContain('DIST-');
    });

    it('acts for the chosen organisation with that membership role', async () => {
      const r = await login(server(), 'distributor@d.test', PASSWORD, 'dist-b');
      expect(r.status).toBe(200);
      expect(r.body.data.acting_as).toMatchObject({ org_id: orgB, role: 'buyer_admin' });
    });

    it('rejects an organisation code the account does not belong to', async () => {
      const r = await login(server(), 'distributor@d.test', PASSWORD, 'NOT-MINE');
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  it('validates the body', async () => {
    const res = await request(server()).post('/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  describe('GET /auth/me', () => {
    it('returns the caller and the membership the token acts with', async () => {
      const t = await seedTenants();
      const r = await login(server(), 'admin@b.test');
      const me = await request(server()).get('/auth/me').set('Authorization', `Bearer ${r.accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.data).toMatchObject({
        user: { id: t.users.adminB },
        acting_as: { org_id: t.buyerB, role: 'buyer_admin' },
      });
    });
  });
});
