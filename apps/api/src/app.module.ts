import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from './modules/audit/audit.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { IdentityModule } from './modules/identity/identity.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { JwtAuthGuard } from './modules/identity/http/jwt-auth.guard';
import { RolesGuard } from './modules/identity/http/roles.guard';
import { OrderingModule } from './modules/ordering/ordering.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { ConfigModule } from './platform/config/config.module';
import { DatabaseModule } from './platform/database/database.module';
import { HealthModule } from './platform/health/health.module';
import { RequestLoggingMiddleware } from './platform/observability/request-logging.middleware';
import { OutboxModule } from './platform/outbox/outbox.module';
import { RateLimitGuard } from './platform/ratelimit/rate-limit.guard';
import { RateLimitModule } from './platform/ratelimit/ratelimit.module';
import { RedisModule } from './platform/redis/redis.module';
import { SchedulerModule } from './platform/scheduler/scheduler.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    RateLimitModule,
    HealthModule,
    OutboxModule,
    SchedulerModule,
    IdentityModule,
    CatalogModule,
    PricingModule,
    InventoryModule,
    AuditModule,
    OrderingModule,
  ],
  providers: [
    // Global guards run in this order: a flood is rejected before any token work,
    // and roles are checked only once the caller is known. Routes are private
    // unless marked @Public().
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggingMiddleware).forRoutes('*');
  }
}
