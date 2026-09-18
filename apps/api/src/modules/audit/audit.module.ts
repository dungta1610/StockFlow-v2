import { Module } from '@nestjs/common';
import { AuditLogHandler } from './application/audit-log.handler';
import { AuditController } from './http/audit.controller';
import { SqlAuditRepository } from './infrastructure/sql-audit.repository';

/**
 * A projection, not a domain: three files (handler, read repository, controller)
 * plus this module. See `AuditLogHandler` for what it keeps of each event.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditLogHandler, SqlAuditRepository],
  exports: [AuditLogHandler, SqlAuditRepository],
})
export class AuditModule {}
