import { Global, Module } from '@nestjs/common';
import { RateLimiter } from './limiter';

/**
 * Provides the limiter. The global RateLimitGuard is registered in AppModule so
 * guard order (rate limit → auth → roles) is declared in one place.
 */
@Global()
@Module({
  providers: [RateLimiter],
  exports: [RateLimiter],
})
export class RateLimitModule {}
