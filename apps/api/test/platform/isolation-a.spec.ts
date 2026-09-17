import { Client } from 'pg';

// Paired with isolation-b.spec.ts: both write the same table and assert they see
// only their own row. If test files ran concurrently against the shared database,
// or state leaked between tests, one of them would see two rows.
describe('test isolation (A)', () => {
  let pg: Client;
  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('CREATE TABLE IF NOT EXISTS commerce.isolation_probe (owner text)');
  });
  afterAll(() => pg.end());

  it('sees only its own row', async () => {
    await pg.query(`INSERT INTO commerce.isolation_probe VALUES ('a')`);
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await pg.query('SELECT owner FROM commerce.isolation_probe');
    expect(rows).toEqual([{ owner: 'a' }]);
  });

  it('starts the next test from an empty table', async () => {
    const { rows } = await pg.query('SELECT owner FROM commerce.isolation_probe');
    expect(rows).toEqual([]);
  });
});
