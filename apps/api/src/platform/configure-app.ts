import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import type { Env } from './config/env.schema';
import { AllExceptionsFilter } from './errors/all-exceptions.filter';

/**
 * App-wide HTTP setup shared by `main.ts` and the e2e tests, so tests exercise
 * the same filters, cookies and CORS policy that production runs.
 */
export function configureApp(app: INestApplication): INestApplication {
  const config = app.get(ConfigService<Env, true>);
  app.enableShutdownHooks();
  // Credentials are needed so the browser sends the refresh cookie to /auth.
  app.enableCors({ origin: config.get('CORS_ORIGINS', { infer: true }), credentials: true });
  app.use(cookieParser());
  app.useGlobalFilters(new AllExceptionsFilter());
  return app;
}
