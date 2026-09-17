import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import type { Env } from '../config/env.schema';
import { PG_POOL } from './database.tokens';
import { createPool } from './pool';
import { UnitOfWork } from './unit-of-work';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createPool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          lockTimeoutMs: config.get('DB_LOCK_TIMEOUT_MS', { infer: true }),
          statementTimeoutMs: config.get('DB_STATEMENT_TIMEOUT_MS', { infer: true }),
          max: config.get('DB_POOL_MAX', { infer: true }),
        }),
    },
    UnitOfWork,
  ],
  exports: [PG_POOL, UnitOfWork],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
