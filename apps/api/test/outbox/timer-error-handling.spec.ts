import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Tx } from '../../src/platform/database/tx';
import { OutboxRelay } from '../../src/platform/outbox/outbox.relay';
import type { OutboxHandler } from '../../src/platform/outbox/outbox-handler.interface';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { configWithOverrides } from '../helpers/config-fixtures';
import { seedTenants } from '../helpers/identity-fixtures';
import { insertOutboxEvent, sleep } from '../helpers/outbox-fixtures';
import { createTestApp } from '../helpers/test-app';

/** Always fails with a real SQL error — before the C1 fix this aborted the
 *  claiming transaction; either way it is a DB error the timer path must not let
 *  become an unhandled rejection (C2). */
class SqlFailingHandler implements OutboxHandler {
  readonly eventTypes = ['test.timer-sql-fail'];
  async handle(tx: Tx): Promise<void> {
    await tx.query('SELECT 1/0');
  }
}

describe('the relay timer never turns a poll failure into an unhandled rejection', () => {
  let app: INestApplication;
  let unhandled: unknown[];
  const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandledRejection);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection);
  });

  it('start() on a short interval against a poisoned event produces no unhandled rejection', async () => {
    const t = await seedTenants();
    const relay = new OutboxRelay(
      app.get(UnitOfWork),
      configWithOverrides(app.get(ConfigService), { OUTBOX_POLL_INTERVAL_MS: 25 }),
    );
    relay.registerHandler(new SqlFailingHandler());
    await insertOutboxEvent(t.buyerA, { eventType: 'test.timer-sql-fail' });

    relay.start();
    await sleep(300); // several ticks, each hitting the same SQL failure
    relay.onApplicationShutdown();

    expect(unhandled).toEqual([]);
  });

  it('start() against an unreachable database (pool ended) produces no unhandled rejection', async () => {
    // A closed pool makes every pollOnce() reject at the connect() step — the same
    // shape of failure a DB restart or ECONNREFUSED produces in production.
    const uow = app.get(UnitOfWork);
    const brokenUow = {
      ...uow,
      withTransaction: () => Promise.reject(new Error('connect ECONNREFUSED')),
    } as unknown as typeof uow;
    const relay = new OutboxRelay(brokenUow, configWithOverrides(app.get(ConfigService), { OUTBOX_POLL_INTERVAL_MS: 25 }));

    relay.start();
    await sleep(150);
    relay.onApplicationShutdown();

    expect(unhandled).toEqual([]);
  });
});
