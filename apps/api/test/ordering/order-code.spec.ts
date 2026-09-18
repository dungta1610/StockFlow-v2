import { withDb } from '../helpers/identity-fixtures';

/** StockFlow drew six random digits per order and relied on UNIQUE to catch collisions. */
describe('order codes', () => {
  it('10,000 codes drawn on one day are all distinct and well formed', async () => {
    const { total, distinct, malformed } = await withDb(async (pg) => {
      const { rows } = await pg.query<{ total: string; distinct: string; malformed: string }>(
        `WITH codes AS (SELECT commerce.next_order_code() AS code FROM generate_series(1, 10000))
         SELECT count(*) AS total, count(DISTINCT code) AS distinct,
                count(*) FILTER (WHERE code !~ '^ORD-\\d{8}-\\d{6,}$') AS malformed
           FROM codes`,
      );
      return rows[0]!;
    });
    expect({ total: Number(total), distinct: Number(distinct), malformed: Number(malformed) }).toEqual({
      total: 10000,
      distinct: 10000,
      malformed: 0,
    });
  });
});
