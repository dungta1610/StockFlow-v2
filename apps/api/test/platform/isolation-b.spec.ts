import { Client } from 'pg';

// See isolation-a.spec.ts.
describe('test isolation (B)', () => {
  let pg: Client;
  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('CREATE TABLE IF NOT EXISTS commerce.isolation_probe (owner text)');
  });
  afterAll(() => pg.end());

  it('sees only its own row', async () => {
    await pg.query(`INSERT INTO commerce.isolation_probe VALUES ('b')`);
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await pg.query('SELECT owner FROM commerce.isolation_probe');
    expect(rows).toEqual([{ owner: 'b' }]);
  });
});
