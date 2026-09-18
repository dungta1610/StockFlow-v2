import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { PG_POOL } from './database.tokens';
import type { IsolationLevel, Tx } from './tx';

const ISOLATION_SQL: Record<IsolationLevel, string> = {
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

const clientTx = (client: PoolClient): Tx => ({
  query: async <T extends QueryResultRow>(sql: string, params?: unknown[]) =>
    (await client.query<T>(sql, params)).rows,
});

/**
 * Opens transactions. Rule (docs/adr/0004): use cases never call this — they
 * receive a `Tx`. Controllers and jobs open the transaction and pass it down,
 * so nothing ever nests a second transaction on a second connection.
 */
@Injectable()
export class UnitOfWork {
  private readonly logger = new Logger(UnitOfWork.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async withTransaction<T>(
    fn: (tx: Tx) => Promise<T>,
    opts: { isolation?: IsolationLevel } = {},
  ): Promise<T> {
    const client = await this.pool.connect();
    // pg-pool only listens for a client's 'error' event while it sits idle in the
    // pool (it removes that listener on checkout and re-adds it on release). For
    // the whole time this client is checked out, nothing listens — so a lost
    // connection (database restart, failover, pg_terminate_backend) mid-transaction
    // emits an unlistened 'error' and crashes the process. This listener closes
    // that gap for the checkout's lifetime; `client.release(err)` below then tells
    // pg-pool to destroy the client instead of re-pooling a broken one.
    let connectionError: Error | undefined;
    const onError = (err: Error) => {
      connectionError = err;
      this.logger.error(`Database connection lost mid-transaction: ${err.message}`);
    };
    client.on('error', onError);
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${ISOLATION_SQL[opts.isolation ?? 'read committed']}`);
      const result = await fn(clientTx(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.off('error', onError);
      client.release(connectionError);
    }
  }

  /** Autocommit handle for single-statement reads that need no transaction. */
  get db(): Tx {
    return {
      query: async <T extends QueryResultRow>(sql: string, params?: unknown[]) =>
        (await this.pool.query<T>(sql, params)).rows,
    };
  }
}
