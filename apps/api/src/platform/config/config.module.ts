import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';

/**
 * Global typed config. The .env lives at the repo root; resolve it whether the
 * process starts from the root or from apps/api. In containers, env vars are
 * injected directly and these files are simply absent.
 */
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env', '../../.env'],
      validate: validateEnv,
    }),
  ],
})
export class ConfigModule {}
