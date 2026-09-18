import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import { bearer, seedTenants } from '../helpers/identity-fixtures';

const newOrg = { code: 'NEW-ORG', name: 'New Org', type: 'buyer' };

describe('authentication and role guards', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('rejects a request without a token (routes are private by default)', async () => {
    const res = await request(server()).get('/users');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed or tampered token', async () => {
    await seedTenants();
    const good = await bearer(server(), 'ops.admin@sf.test');
    const tampered = good.slice(0, -3) + (good.endsWith('abc') ? 'xyz' : 'abc');

    for (const auth of ['Bearer nope', 'Basic abc', tampered]) {
      const res = await request(server()).get('/users').set('Authorization', auth);
      expect(res.status).toBe(401);
      // Missing scheme (Basic abc) and an invalid/tampered bearer token are different
      // situations but the same failure from the caller's point of view, so both
      // render the same code as the no-token case above.
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects an expired token', async () => {
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    const t = await seedTenants();
    const expired = await jwt.signAsync(
      { sub: t.users.opsAdmin, org: t.internal, ot: 'internal', roles: ['ops_admin'] },
      { expiresIn: -10 },
    );
    const res = await request(server()).get('/users').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('lets public routes through without a token', async () => {
    expect((await request(server()).get('/health')).status).toBe(200);
  });

  it('allows creating an organisation only to ops_admin', async () => {
    await seedTenants();
    const post = (auth: string) => request(server()).post('/organizations').set('Authorization', auth).send(newOrg);

    const denied = await post(await bearer(server(), 'ops@sf.test'));
    expect(denied.status).toBe(403);
    // Same code the use-case-level assertRole check renders (use-case-authorization.spec.ts):
    // the route guard and the service check are the same failure to a caller.
    expect(denied.body.error.code).toBe('FORBIDDEN');
    expect((await post(await bearer(server(), 'admin@a.test'))).status).toBe(403);
    expect((await post(await bearer(server(), 'buyer@a.test'))).status).toBe(403);

    const ok = await post(await bearer(server(), 'ops.admin@sf.test'));
    expect(ok.status).toBe(201);
  });

  it('allows user administration only to admin roles', async () => {
    await seedTenants();
    const list = async (email: string) => request(server()).get('/users').set('Authorization', await bearer(server(), email));

    const buyerDenied = await list('buyer@a.test');
    expect(buyerDenied.status).toBe(403);
    expect(buyerDenied.body.error.code).toBe('FORBIDDEN');
    expect((await list('ops@sf.test')).status).toBe(403);
    expect((await list('admin@a.test')).status).toBe(200);
    expect((await list('ops.admin@sf.test')).status).toBe(200);
  });
});
