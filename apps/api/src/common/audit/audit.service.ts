import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType, type Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditRecord {
  /**
   * NULL only when actorType is PUBLIC (approved resolution, 8 Aug 2026).
   * The pairing is enforced by a database CHECK constraint.
   */
  actorId: string | null;
  actorType: AuditActorType;
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
    /*
     * The database CHECK constraint is the authority on this pairing. The
     * assertion here exists only to fail with a message a developer can act
     * on, rather than a raw constraint violation from Postgres.
     */
    const usesActor = entry.actorType === AuditActorType.USER;
    if (usesActor && !entry.actorId) {
      throw new Error(`Audit action '${entry.action}' is USER but carries no actorId`);
    }
    if (!usesActor && entry.actorId) {
      throw new Error(`Audit action '${entry.action}' is PUBLIC but carries an actorId`);
    }

    await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        actorType: entry.actorType,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        correlationId: entry.correlationId,
        beforeState: entry.beforeState ?? undefined,
        afterState: entry.afterState ?? undefined,
      },
    });

    this.logger.debug(
      `audit: ${entry.action} ${entry.resourceType}:${entry.resourceId} (${entry.actorType})`,
    );
  }
}
