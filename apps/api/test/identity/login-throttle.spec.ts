import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import { PASSWORD, login, seedTenants } from '../helpers/identity-fixtures';

// LOGIN_MAX_ATTEMPTS=5 and LOGIN_MAX_ATTEMPTS_PER_IP=20 in test/setup.ts.
describe('login throttling', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer();
  const fail = (email: string, times: number) =>
    Array.from({ length: times }).reduce<Promise<unknown>>(
      (p) => p.then(() => login(server(), email, 'wrong-password')),
      Promise.resolve(),
    );

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('locks an account after 5 failures, even for the correct password', async () => {
    await seedTenants();
    await fail('buyer@a.test', 5);
    const r = await login(server(), 'buyer@a.test', PASSWORD);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('LOGIN_LOCKED');
  });

  it('locks per account: another account from the same client still works', async () => {
    await seedTenants();
    await fail('buyer@a.test', 5);
    expect((await login(server(), 'buyer@b.test')).status).toBe(200);
  });

  it('behaves identically for an email that does not exist (no account enumeration)', async () => {
    await fail('ghost@nowhere.test', 5);
    const r = await login(server(), 'ghost@nowhere.test');
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('LOGIN_LOCKED');
  });

  it('counts only failures: a successful login resets the counter', async () => {
    await seedTenants();
    await fail('buyer@a.test', 4);
    expect((await login(server(), 'buyer@a.test')).status).toBe(200);
    await fail('buyer@a.test', 4);
    expect((await login(server(), 'buyer@a.test')).status).toBe(200);
  });

  it('caps failures per client IP across different accounts', async () => {
    await seedTenants();
    // 20 failures spread over 5 accounts (4 each, so no single account is locked).
    for (const email of ['a1@x.test', 'a2@x.test', 'a3@x.test', 'a4@x.test', 'a5@x.test']) {
      await fail(email, 4);
    }
    const r = await login(server(), 'buyer@b.test');
    expect(r.status).toBe(429);
  });

  it('cannot be bypassed by sending the attempts in parallel', async () => {
    await seedTenants();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => login(server(), 'buyer@a.test', 'wrong-password')),
    );
    const codes = results.map((r) => r.body.error.code);
    expect(codes.filter((c) => c === 'INVALID_CREDENTIALS')).toHaveLength(5);
    expect(codes.filter((c) => c === 'LOGIN_LOCKED')).toHaveLength(15);
    expect((await login(server(), 'buyer@a.test')).status).toBe(429);
  });

  it('does not let successful logins from a shared IP accumulate toward the IP cap', async () => {
    await seedTenants();
    // 25 successes from one client (IP cap is 20).
    for (let i = 0; i < 25; i++) expect((await login(server(), 'buyer@b.test')).status).toBe(200);
  });

  it('keeps the counter key case-insensitive', async () => {
    await seedTenants();
    await fail('Buyer@A.test', 5);
    expect((await request(server()).post('/auth/login').send({ email: 'buyer@a.test', password: PASSWORD })).status).toBe(429);
  });
});
