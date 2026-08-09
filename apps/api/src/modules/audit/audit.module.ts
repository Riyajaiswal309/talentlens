import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditExportService } from './audit-export.service';
import { AuditQueryService } from './audit-query.service';

/**
 * PRD §15.3 `AuditModule` — FR8.3, NFR8.
 *
 * Read side only. Writing is AuditService in common/, reached through
 * AuditInterceptor; nothing here can create an audit record, which keeps the
 * append-only guarantee a property of the architecture and not of review.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditQueryService, AuditExportService],
  exports: [AuditQueryService],
})
export class AuditModule {}
