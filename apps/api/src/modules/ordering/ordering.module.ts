import { Module } from '@nestjs/common';
import { OutboxModule } from '../../platform/outbox/outbox.module';
import { SchedulerModule } from '../../platform/scheduler/scheduler.module';
import { AuditModule } from '../audit/audit.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PricingModule } from '../pricing/pricing.module';
import { IdempotencyCleanupJob } from './application/idempotency-cleanup.job';
import { IdempotencyService } from './application/idempotency.service';
import { OrderService } from './application/order.service';
import { OutboxBindings } from './application/outbox-bindings';
import { IdempotencyRepository } from './application/ports/idempotency.repository';
import { OrderRepository } from './application/ports/order.repository';
import { OutboxRepository } from './application/ports/outbox.repository';
import { ReservationRepository } from './application/ports/reservation.repository';
import { ReservationExpiryJob } from './application/reservation-expiry.job';
import { ReservationService } from './application/reservation.service';
import { CreateOrderUseCase } from './application/use-cases/create-order.use-case';
import {
  CancelOrderUseCase,
  ExpireOrderUseCase,
  FulfillOrderUseCase,
  MarkOrderPaidUseCase,
  OrderTransitions,
} from './application/use-cases/order-transition.use-cases';
import { OrderController } from './http/order.controller';
import { OpsOutboxController } from './http/ops-outbox.controller';
import { SqlIdempotencyRepository } from './infrastructure/sql-idempotency.repository';
import { SqlOrderRepository } from './infrastructure/sql-order.repository';
import { SqlOutboxRepository } from './infrastructure/sql-outbox.repository';
import { SqlReservationRepository } from './infrastructure/sql-reservation.repository';

@Module({
  imports: [CatalogModule, PricingModule, InventoryModule, AuditModule, OutboxModule, SchedulerModule],
  controllers: [OrderController, OpsOutboxController],
  providers: [
    { provide: OrderRepository, useClass: SqlOrderRepository },
    { provide: ReservationRepository, useClass: SqlReservationRepository },
    { provide: OutboxRepository, useClass: SqlOutboxRepository },
    { provide: IdempotencyRepository, useClass: SqlIdempotencyRepository },
    IdempotencyService,
    CreateOrderUseCase,
    OrderTransitions,
    CancelOrderUseCase,
    ExpireOrderUseCase,
    MarkOrderPaidUseCase,
    FulfillOrderUseCase,
    OrderService,
    ReservationService,
    OutboxBindings,
    ReservationExpiryJob,
    IdempotencyCleanupJob,
  ],
  // The expiry sweep runs ExpireOrderUseCase; the copilot reads through the services.
  exports: [ExpireOrderUseCase, OrderService, ReservationService],
})
export class OrderingModule {}
