import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditRecord {
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  correlationId: string;
  beforeState?: Prisma.InputJsonValue | null;
  afterState?: Prisma.InputJsonValue | null;
}

/**
 * Writes the append-only audit trail (PRD FR8.3, BR-03, NFR8).
 *
 * Deliberately offers no update or delete method. That is not an oversight
 * and not merely convention: M2.2 granted the application role INSERT and
 * SELECT only on audit_logs, so the database would reject a mutation even if
 * one were written here (PRD §17.3).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist one audit record.
   *
   * Intentionally NOT wrapped in try/catch. PRD §15.1 principle 4 makes audit
   * logging "synchronous and non-optional" — if the audit write fails, the
   * request must fail too. Swallowing the error would let an unaudited
   * mutation be acknowledged as successful, which BR-03 forbids.
   */
  async record(entry: AuditRecord): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        correlationId: entry.correlationId,
        beforeState: entry.beforeState ?? undefined,
        afterState: entry.afterState ?? undefined,
      },
    });

    this.logger.debug(`audit: ${entry.action} ${entry.resourceType}:${entry.resourceId}`);
  }
}
