import { hash } from '@node-rs/argon2';
import { Client } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';
import type { App } from 'supertest/types';

export const PASSWORD = 'correct-horse-battery';

type OrgType = 'buyer' | 'internal';
type Role = 'buyer' | 'buyer_admin' | 'ops' | 'ops_admin';

export async function withDb<T>(fn: (pg: Client) => Promise<T>): Promise<T> {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    return await fn(pg);
  } finally {
    await pg.end();
  }
}

export async function insertOrg(
  pg: Client,
  o: { code: string; type: OrgType; name?: string; isActive?: boolean },
): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `INSERT INTO commerce.organizations (code, name, type, is_active)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [o.code, o.name ?? o.code, o.type, o.isActive ?? true],
  );
  return rows[0]!.id;
}

export async function insertUser(
  pg: Client,
  u: {
    email: string;
    fullName?: string;
    password?: string;
    isActive?: boolean;
    memberships: { orgId: string; orgType: OrgType; role: Role }[];
  },
): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `INSERT INTO commerce.users (email, password_hash, full_name, is_active)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [u.email, await hash(u.password ?? PASSWORD), u.fullName ?? u.email, u.isActive ?? true],
  );
  const id = rows[0]!.id;
  for (const m of u.memberships) {
    await pg.query(
      `INSERT INTO commerce.org_members (org_id, org_type, user_id, role) VALUES ($1, $2, $3, $4)`,
      [m.orgId, m.orgType, id, m.role],
    );
  }
  return id;
}

export interface Tenants {
  internal: string;
  buyerA: string;
  buyerB: string;
  users: {
    opsAdmin: string;
    ops: string;
    adminA: string;
    buyerA: string;
    adminB: string;
    buyerB: string;
  };
}

/** One internal org with ops staff, and two buyer orgs each with an admin and a buyer. */
export function seedTenants(): Promise<Tenants> {
  return withDb(async (pg) => {
    const internal = await insertOrg(pg, { code: 'INTERNAL', type: 'internal' });
    const buyerA = await insertOrg(pg, { code: 'BUYER-A', type: 'buyer' });
    const buyerB = await insertOrg(pg, { code: 'BUYER-B', type: 'buyer' });
    const member = (orgId: string, orgType: OrgType, role: Role) => [{ orgId, orgType, role }];
    return {
      internal,
      buyerA,
      buyerB,
      users: {
        opsAdmin: await insertUser(pg, { email: 'ops.admin@sf.test', memberships: member(internal, 'internal', 'ops_admin') }),
        ops: await insertUser(pg, { email: 'ops@sf.test', memberships: member(internal, 'internal', 'ops') }),
        adminA: await insertUser(pg, { email: 'admin@a.test', memberships: member(buyerA, 'buyer', 'buyer_admin') }),
        buyerA: await insertUser(pg, { email: 'buyer@a.test', memberships: member(buyerA, 'buyer', 'buyer') }),
        adminB: await insertUser(pg, { email: 'admin@b.test', memberships: member(buyerB, 'buyer', 'buyer_admin') }),
        buyerB: await insertUser(pg, { email: 'buyer@b.test', memberships: member(buyerB, 'buyer', 'buyer') }),
      },
    };
  });
}

export interface LoginResult {
  status: number;
  body: Response['body'];
  accessToken: string;
  /** `sf_refresh=<value>` ready to send back as a Cookie header. */
  refreshCookie: string;
  setCookie: string;
}

export async function login(
  server: App,
  email: string,
  password = PASSWORD,
  orgCode?: string,
): Promise<LoginResult> {
  const res = await request(server)
    .post('/auth/login')
    .send({ email, password, ...(orgCode && { org_code: orgCode }) });
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join('; ');
  return {
    status: res.status,
    body: res.body,
    accessToken: res.body?.data?.access_token ?? '',
    refreshCookie: refreshCookieFrom(res.headers['set-cookie']),
    setCookie,
  };
}

export function refreshCookieFrom(header: string | string[] | undefined): string {
  const cookie = ([] as string[]).concat(header ?? []).find((c) => c.startsWith('sf_refresh='));
  return cookie ? cookie.split(';')[0]! : '';
}

/** Log in and return an Authorization header value. */
export async function bearer(server: App, email: string, orgCode?: string): Promise<string> {
  const r = await login(server, email, PASSWORD, orgCode);
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return `Bearer ${r.accessToken}`;
}
