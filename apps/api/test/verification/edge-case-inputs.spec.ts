import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import { bearer, seedTenants, type Tenants } from '../helpers/identity-fixtures';

// Hostile or out-of-range query input on /users. Each case pins the exact outcome,
// not merely "did not crash".
describe('edge-case inputs on /users', () => {
  let app: INestApplication;
  let t: Tenants;
  let adminA: string;
  const server = () => app.getHttpServer();
  const get = (qs: string, headers: Record<string, string> = {}) =>
    request(server()).get(`/users${qs}`).set('Authorization', adminA).set(headers);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    adminA = await bearer(server(), 'admin@a.test');
  });

  describe('LIKE wildcards and quoting in filters are literal', () => {
    // Unescaped, `%` and `_` would match every name and return both users of org A.
    it.each([
      ['%25', '%'],
      ['_', '_'],
      ['%25%25', '%%'],
    ])('full_name=%s matches nothing', async (encoded) => {
      const res = await get(`?full_name=${encoded}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it.each([
      ["x' OR '1'='1", 'single quote'],
      ['x"; DROP TABLE users; --', 'statement terminator'],
      ['\\', 'backslash'],
    ])('full_name with %s is a harmless literal (%s)', async (value) => {
      const res = await get(`?full_name=${encodeURIComponent(value)}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('email with SQL metacharacters matches nothing and leaves the table intact', async () => {
      const res = await get(`?email=${encodeURIComponent("a@a.test'; DELETE FROM users; --")}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect((await get('')).body.data).toHaveLength(2);
    });
  });

  describe('paging edge values', () => {
    it.each([
      ['?page=-1', { page: 1, limit: 10 }],
      ['?limit=-1', { page: 1, limit: 10 }],
      ['?limit=0', { page: 1, limit: 10 }],
      ['?limit=999999999', { page: 1, limit: 100 }],
    ])('%s is normalised to %j', async (qs, paging) => {
      const res = await get(qs);
      expect(res.status).toBe(200);
      expect(res.body.paging).toEqual(paging);
    });

    it.each(['?page=1.5', '?limit=2.5', '?page=1e3x'])('%s is rejected with 400', async (qs) => {
      const res = await get(qs);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    it('a page past the end is an empty page, not an error', async () => {
      const res = await get('?page=999999999');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('org_id filter', () => {
    it('rejects a non-uuid with 400', async () => {
      const res = await get('?org_id=not-a-uuid');
      expect(res.status).toBe(400);
    });

    it('returns nothing for an organisation outside the caller’s scope', async () => {
      const res = await get(`?org_id=${t.buyerB}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('x-request-id', () => {
    it.each([
      ['x'.repeat(1000), 'too long'],
      ['!@#$%^&*()', 'illegal characters'],
      ['short', 'too short'],
    ])('replaces an unusable inbound id (%s: %s) with a fresh uuid', async (id) => {
      const res = await get('', { 'x-request-id': id });
      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});
