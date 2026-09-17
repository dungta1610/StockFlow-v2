import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { resolve } from 'node:path';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/platform/database/migrator';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

export const MIGRATIONS_DIR = resolve(__dirname, '../../../db/migrations');

/** Starts the shared containers once per run and applies every migration. */
export default async function setup(project: TestProject) {
  const [pg, redis]: [StartedPostgreSqlContainer, StartedTestContainer] = await Promise.all([
    new PostgreSqlContainer('pgvector/pgvector:0.8.1-pg16')
      .withDatabase('stockflow_test')
      // Phase 04 concurrency tests hold ~60 connections at once.
      .withCommand(['postgres', '-c', 'max_connections=200'])
      .start(),
    new GenericContainer('redis:7.4-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);

  const databaseUrl = pg.getConnectionUri();
  await runMigrations(databaseUrl, MIGRATIONS_DIR);

  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`);

  return async () => {
    await Promise.all([pg.stop(), redis.stop()]);
  };
}
