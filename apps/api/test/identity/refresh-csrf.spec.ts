import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import { login, seedTenants } from '../helpers/identity-fixtures';

// The refresh cookie is sent automatically by browsers. A cross-site page that can
// trigger a refresh would rotate the victim's token and — because reuse is treated
// as theft — get the victim's real session revoked. These tests pin that down.
describe('refresh endpoint origin check', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('refuses a foreign origin without touching the session', async () => {
    await seedTenants();
    const { refreshCookie } = await login(server(), 'buyer@a.test');

    const forged = await request(server())
      .post('/auth/refresh')
      .set('Cookie', refreshCookie)
      .set('Origin', 'https://evil.example');
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('FORBIDDEN_ORIGIN');
    expect(forged.headers['set-cookie']).toBeUndefined();

    // The same token still works: it was neither consumed nor was its family revoked.
    const legit = await request(server())
      .post('/auth/refresh')
      .set('Cookie', refreshCookie)
      .set('Origin', 'http://localhost:5173');
    expect(legit.status).toBe(200);
  });

  it('refuses a foreign origin on logout, leaving the session alive', async () => {
    await seedTenants();
    const { refreshCookie } = await login(server(), 'buyer@a.test');

    const forged = await request(server())
      .post('/auth/logout')
      .set('Cookie', refreshCookie)
      .set('Origin', 'https://evil.example');
    expect(forged.status).toBe(403);

    expect((await request(server()).post('/auth/refresh').set('Cookie', refreshCookie)).status).toBe(200);
  });

  it('accepts requests without an Origin header (non-browser clients)', async () => {
    await seedTenants();
    const { refreshCookie } = await login(server(), 'buyer@a.test');
    const res = await request(server()).post('/auth/refresh').set('Cookie', refreshCookie);
    expect(res.status).toBe(200);
  });
});
