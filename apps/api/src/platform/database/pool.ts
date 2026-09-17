import { Logger } from '@nestjs/common';
import { Pool } from 'pg';

export interface PoolOptions {
  connectionString: string;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  max: number;
}

const logger = new Logger('PgPool');

/**
 * Builds the shared pool. Timeouts, isolation and search_path are set in the
 * connection startup packet, so every connection has them before its first query —
 * no per-checkout SET that could race or be forgotten. Unqualified table names
 * resolve to the `commerce` schema; `public` stays on the path for extensions.
 */
export function createPool(opts: PoolOptions): Pool {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.max,
    application_name: 'stockflow-api',
    options: [
      `-c lock_timeout=${opts.lockTimeoutMs}`,
      `-c statement_timeout=${opts.statementTimeoutMs}`,
      '-c default_transaction_isolation=read\\ committed',
      '-c search_path=commerce,public',
    ].join(' '),
  });

  // An idle client that loses its connection (database restart, network blip)
  // emits 'error' on the pool. Without a listener Node treats it as an unhandled
  // error event and the whole process exits. The pool discards the broken client
  // and opens a new one on the next checkout.
  pool.on('error', (err) => {
    logger.error(`Idle database connection failed: ${err.message}`);
  });

  return pool;
}
