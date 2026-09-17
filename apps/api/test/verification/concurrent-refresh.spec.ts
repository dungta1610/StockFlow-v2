import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import { login, refreshCookieFrom, seedTenants } from '../helpers/identity-fixtures';

// Two refreshes racing with the same token. The claim is a single conditional
// UPDATE, so exactly one can win. The loser presents a token that is now spent,
// which reuse detection treats as theft: the whole family — including the token
// the winner just received — is revoked. This pins down the documented behaviour
// behind "two tabs refreshing at once log the user out" (docs/adr/0009); the web
// client must serialise refreshes across tabs.
describe('concurrent refresh with the same token', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer();
  const refresh = (cookie: string) => request(server()).post('/auth/refresh').set('Cookie', cookie);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('lets exactly one request win', async () => {
    await seedTenants();
    const { refreshCookie } = await login(server(), 'buyer@a.test');

    const results = await Promise.all([refresh(refreshCookie), refresh(refreshCookie)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const loser = results.find((r) => r.status === 401)!;
    expect(loser.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('revokes the family, so the winner’s new token is dead too', async () => {
    await seedTenants();
    const { refreshCookie } = await login(server(), 'buyer@a.test');

    const results = await Promise.all([refresh(refreshCookie), refresh(refreshCookie)]);
    const winnerCookie = refreshCookieFrom(results.find((r) => r.status === 200)!.headers['set-cookie']);
    expect(winnerCookie).toMatch(/^sf_refresh=/);

    expect((await refresh(winnerCookie)).status).toBe(401);
  });

  it('never issues two valid tokens from one, across a larger burst', async () => {
    await seedTenants();
    const { refreshCookie } = await login(server(), 'buyer@a.test');

    const results = await Promise.all(Array.from({ length: 10 }, () => refresh(refreshCookie)));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(9);
  });
});
