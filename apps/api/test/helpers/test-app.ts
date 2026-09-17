import type { INestApplication, ModuleMetadata, Provider } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/platform/configure-app';

export interface TestAppOptions {
  /** Extra modules/controllers mounted next to AppModule (test-only endpoints). */
  extra?: Pick<ModuleMetadata, 'controllers' | 'imports'> & { providers?: Provider[] };
  /** Replace providers, e.g. a pool pointed at a dead database. */
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/** Boots the real AppModule with production HTTP setup (filters, CORS). */
export async function createTestApp(opts: TestAppOptions = {}): Promise<INestApplication> {
  let builder = Test.createTestingModule({
    imports: [AppModule, ...(opts.extra?.imports ?? [])],
    controllers: opts.extra?.controllers ?? [],
    providers: opts.extra?.providers ?? [],
  });
  if (opts.override) builder = opts.override(builder);

  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  return app;
}
