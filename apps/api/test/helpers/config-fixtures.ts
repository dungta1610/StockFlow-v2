import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../src/platform/config/env.schema';

/**
 * Wraps a real `ConfigService`, overriding specific keys. `NestConfigModule.forRoot()`
 * validates `process.env` synchronously the first time `platform/config/config.module.ts`
 * is imported — module caching means that happens once for the whole test run, so a
 * `process.env.X = ...` assignment in a later test file's `beforeAll` never reaches
 * it. Tests that need a non-default value construct the class under test directly
 * (as several already do for concurrency) and pass one of these instead.
 */
export function configWithOverrides(base: ConfigService<Env, true>, overrides: Partial<Env>): ConfigService<Env, true> {
  const get = (key: keyof Env, ...rest: unknown[]) => {
    if (key in overrides) return overrides[key];
    return (base.get as (...args: unknown[]) => unknown)(key, ...rest);
  };
  // Only `get` is exercised by this codebase's config consumers.
  return { get } as unknown as ConfigService<Env, true>;
}
