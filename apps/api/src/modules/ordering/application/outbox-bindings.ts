import { Injectable, type OnModuleInit } from '@nestjs/common';
import { OutboxRelay } from '../../../platform/outbox/outbox.relay';
import { AuditLogHandler } from '../../audit/application/audit-log.handler';

/**
 * Routes `order.*` outbox events to their consumers. Adding one is one file — a
 * class implementing `OutboxHandler` — plus one `registerHandler()` call here; the
 * relay's polling, retry and dead-letter machinery never changes (docs/adr/0017).
 * This lives in `modules/`, not `platform/`, because routing is policy: it knows
 * which event types exist and which handler wants them.
 */
@Injectable()
export class OutboxBindings implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelay,
    private readonly auditLog: AuditLogHandler,
  ) {}

  onModuleInit(): void {
    this.relay.registerHandler(this.auditLog);
  }
}
