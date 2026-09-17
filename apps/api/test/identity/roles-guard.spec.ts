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
      expect((await request(server()).get('/users').set('Authorization', auth)).status).toBe(401);
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
  });

  it('lets public routes through without a token', async () => {
    expect((await request(server()).get('/health')).status).toBe(200);
  });

  it('allows creating an organisation only to ops_admin', async () => {
    await seedTenants();
    const post = (auth: string) => request(server()).post('/organizations').set('Authorization', auth).send(newOrg);

    expect((await post(await bearer(server(), 'ops@sf.test'))).status).toBe(403);
    expect((await post(await bearer(server(), 'admin@a.test'))).status).toBe(403);
    expect((await post(await bearer(server(), 'buyer@a.test'))).status).toBe(403);

    const ok = await post(await bearer(server(), 'ops.admin@sf.test'));
    expect(ok.status).toBe(201);
  });

  it('allows user administration only to admin roles', async () => {
    await seedTenants();
    const list = async (email: string) =>
      (await request(server()).get('/users').set('Authorization', await bearer(server(), email))).status;

    expect(await list('buyer@a.test')).toBe(403);
    expect(await list('ops@sf.test')).toBe(403);
    expect(await list('admin@a.test')).toBe(200);
    expect(await list('ops.admin@sf.test')).toBe(200);
  });
});
