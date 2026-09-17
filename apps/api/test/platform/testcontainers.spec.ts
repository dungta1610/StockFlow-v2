import { Client } from 'pg';

describe('test infrastructure', () => {
  let pg: Client;

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });
  afterAll(() => pg.end());

  it('has created both schemas', async () => {
    const { rows } = await pg.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname IN ('commerce', 'ai') ORDER BY nspname`,
    );
    expect(rows.map((r) => r.nspname)).toEqual(['ai', 'commerce']);
  });

  it('creates unqualified migration tables in the commerce schema, not public', async () => {
    const { rows } = await pg.query(
      `SELECT to_regclass('commerce.organizations') AS commerce, to_regclass('public.organizations') AS public`,
    );
    expect(rows[0]).toEqual({ commerce: 'commerce.organizations', public: null });
  });

  it('has the vector and citext extensions', async () => {
    const { rows } = await pg.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname IN ('vector', 'citext') ORDER BY extname`,
    );
    expect(rows.map((r) => r.extname)).toEqual(['citext', 'vector']);
  });
});
