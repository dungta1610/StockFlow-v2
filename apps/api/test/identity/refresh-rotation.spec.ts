import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import { login, refreshCookieFrom, seedTenants, withDb } from '../helpers/identity-fixtures';

describe('refresh token rotation', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer();
  const refresh = (cookie: string) => request(server()).post('/auth/refresh').set('Cookie', cookie);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('issues a new access token and a new refresh token, and retires the old one', async () => {
    await seedTenants();
    const { refreshCookie: first } = await login(server(), 'buyer@a.test');

    const res = await refresh(first);
    expect(res.status).toBe(200);
    expect(res.body.data.access_token.split('.')).toHaveLength(3);
    const second = refreshCookieFrom(res.headers['set-cookie']);
    expect(second).toMatch(/^sf_refresh=/);
    expect(second).not.toBe(first);

    const me = await request(server())
      .get('/auth/me')
      .set('Authorization', `Bearer ${res.body.data.access_token}`);
    expect(me.status).toBe(200);
  });

  it('keeps acting for the organisation chosen at login', async () => {
    const t = await seedTenants();
    const { refreshCookie } = await login(server(), 'admin@a.test');
    const res = await refresh(refreshCookie);
    expect(res.body.data.acting_as).toMatchObject({ org_id: t.buyerA, role: 'buyer_admin' });
  });

  it('treats reuse of a spent token as theft and revokes the whole family', async () => {
    await seedTenants();
    const { refreshCookie: first } = await login(server(), 'buyer@a.test');
    const rotated = refreshCookieFrom((await refresh(first)).headers['set-cookie']);

    // The attacker replays the spent token…
    const replay = await refresh(first);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_INVALID');

    // …and the legitimate holder's newer token is dead too.
    expect((await refresh(rotated)).status).toBe(401);
  });

  it('does not revoke other sessions of the same user', async () => {
    await seedTenants();
    const laptop = await login(server(), 'buyer@a.test');
    const phone = await login(server(), 'buyer@a.test');

    await refresh(laptop.refreshCookie);
    await refresh(laptop.refreshCookie); // reuse on the laptop session

    expect((await refresh(phone.refreshCookie)).status).toBe(200);
  });

  it('rejects an expired token', async () => {
    await seedTenants();
    const { refreshCookie } = await login(server(), 'buyer@a.test');
    await withDb((pg) => pg.query(`UPDATE commerce.refresh_tokens SET expires_at = now() - interval '1 second'`));
    expect((await refresh(refreshCookie)).status).toBe(401);
  });

  it('never extends a session past its absolute end, however often it is refreshed', async () => {
    await seedTenants();
    const { refreshCookie } = await login(server(), 'buyer@a.test');
    // The session is about to end in one hour.
    await withDb((pg) =>
      pg.query(`UPDATE commerce.refresh_tokens SET session_expires_at = now() + interval '1 hour'`),
    );

    const res = await refresh(refreshCookie);
    expect(res.status).toBe(200);

    const { rows } = await withDb((pg) =>
      pg.query(
        `SELECT expires_at, session_expires_at FROM commerce.refresh_tokens
          WHERE used_at IS NULL AND revoked_at IS NULL`,
      ),
    );
    expect(rows).toHaveLength(1);
    const { expires_at, session_expires_at } = rows[0];
    // Capped at the session end (not the usual 7 days), and the end itself is carried over.
    expect(new Date(expires_at).getTime()).toBe(new Date(session_expires_at).getTime());
    expect(new Date(session_expires_at).getTime() - Date.now()).toBeLessThan(3600_000 + 5_000);
  });

  it('a new login starts a session that ends in 30 days', async () => {
    await seedTenants();
    await login(server(), 'buyer@a.test');
    const { rows } = await withDb((pg) =>
      pg.query(`SELECT extract(epoch FROM session_expires_at - created_at)::int AS secs FROM commerce.refresh_tokens`),
    );
    expect(Math.abs(rows[0].secs - 30 * 24 * 3600)).toBeLessThan(5);
  });

  it('rejects a missing or unknown token', async () => {
    expect((await request(server()).post('/auth/refresh')).status).toBe(401);
    expect((await refresh('sf_refresh=forged-value')).status).toBe(401);
  });

  it('stops refreshing once the user is deactivated', async () => {
    const t = await seedTenants();
    const { refreshCookie } = await login(server(), 'buyer@a.test');
    await withDb((pg) => pg.query('UPDATE commerce.users SET is_active = false WHERE id = $1', [t.users.buyerA]));
    expect((await refresh(refreshCookie)).status).toBe(401);
  });

  it('stops refreshing once the membership is removed', async () => {
    const t = await seedTenants();
    const { refreshCookie } = await login(server(), 'buyer@a.test');
    await withDb((pg) => pg.query('DELETE FROM commerce.org_members WHERE user_id = $1', [t.users.buyerA]));
    expect((await refresh(refreshCookie)).status).toBe(401);
  });

  it('stores only a hash of the token', async () => {
    await seedTenants();
    const { refreshCookie } = await login(server(), 'buyer@a.test');
    const raw = refreshCookie.split('=')[1]!;
    const { rows } = await withDb((pg) => pg.query('SELECT token_hash FROM commerce.refresh_tokens'));
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toContain(raw);
  });

  describe('POST /auth/logout', () => {
    it('revokes the session family and clears the cookie', async () => {
      await seedTenants();
      const { refreshCookie } = await login(server(), 'buyer@a.test');

      const res = await request(server()).post('/auth/logout').set('Cookie', refreshCookie);
      expect(res.status).toBe(204);
      expect(([] as string[]).concat(res.headers['set-cookie'] ?? []).join()).toMatch(/sf_refresh=;/);

      expect((await refresh(refreshCookie)).status).toBe(401);
    });

    it('succeeds without a cookie', async () => {
      expect((await request(server()).post('/auth/logout')).status).toBe(204);
    });
  });
});
