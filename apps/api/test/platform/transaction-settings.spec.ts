import type { INestApplication } from '@nestjs/common';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { createTestApp } from '../helpers/test-app';

describe('UnitOfWork transaction settings', () => {
  let app: INestApplication;
  let uow: UnitOfWork;

  beforeAll(async () => {
    app = await createTestApp();
    uow = app.get(UnitOfWork);
  });
  afterAll(() => app.close());

  const show = async (setting: string) =>
    uow.withTransaction(async (tx) => {
      const [row] = await tx.query<Record<string, string>>(`SHOW ${setting}`);
      return Object.values(row!)[0];
    });

  it('runs at READ COMMITTED by default', async () => {
    expect(await show('transaction_isolation')).toBe('read committed');
  });

  it('applies the lock and statement timeouts to every connection', async () => {
    expect(await show('lock_timeout')).toBe('5s');
    expect(await show('statement_timeout')).toBe('15s');
  });

  it('resolves unqualified names against the commerce schema', async () => {
    expect(await show('search_path')).toBe('commerce,public');
  });

  it('honours an explicit isolation level', async () => {
    const level = await uow.withTransaction(
      async (tx) => (await tx.query<{ transaction_isolation: string }>('SHOW transaction_isolation'))[0]!
        .transaction_isolation,
      { isolation: 'serializable' },
    );
    expect(level).toBe('serializable');
  });

  it('rolls back everything when the callback throws', async () => {
    await uow.db.query('CREATE TABLE IF NOT EXISTS commerce.uow_probe (id int)');
    await expect(
      uow.withTransaction(async (tx) => {
        await tx.query('INSERT INTO uow_probe VALUES (1)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await uow.db.query('SELECT * FROM uow_probe')).toHaveLength(0);
    await uow.db.query('DROP TABLE commerce.uow_probe');
  });
});
