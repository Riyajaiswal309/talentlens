import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuditLog, Prisma, Users } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { EXPORT_ACTION } from './audit-actions';
import { MAX_RANGE_DAYS, type QueryAuditDto } from './dto/query-audit.dto';

const DEFAULT_PAGE_SIZE = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AuditEntry = AuditLog & { actor: Pick<Users, 'id' | 'email'> | null };

/** Detail view adds the model version, where the entry is about a score. */
export interface AuditEntryDetail {
  entry: AuditEntry;
  modelVersion: string | null;
  overrideReason: string | null;
}

@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the tenant-scoped filter for an audit query (Gap 4).
   *
   * `companyId` is matched exactly and never left open. Historical rows with
   * a NULL company_id — written before M2.10 and unresolvable at backfill —
   * are therefore invisible to every tenant, which is the safe direction: an
   * unattributable record must not surface under a tenant that may not own it.
   */
  private async buildWhere(
    admin: AuthenticatedUser,
    query: QueryAuditDto,
  ): Promise<Prisma.AuditLogWhereInput> {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;

    if (from && to) {
      if (from > to) {
        throw new BadRequestException('from must be earlier than or equal to to');
      }
      if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
        throw new BadRequestException(`A query may span at most ${MAX_RANGE_DAYS} days`);
      }
    }

    return {
      companyId: admin.companyId,
      ...(query.actionType ? { action: query.actionType } : {}),
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
      ...(query.jobId ? await this.jobScope(admin, query.jobId) : {}),
    };
  }

  /**
   * APPROVED wider `jobId` meaning (9 Aug 2026).
   *
   * An audit row records a resource id, not a job id, so "everything about
   * this job" has to be assembled: the job itself, its applications, and the
   * scorecards and match scores hanging off those applications. §9.3's
   * purpose is reconciling a role's hiring activity, and the narrow reading
   * would omit the stage changes and overrides that make up most of it.
   *
   * The job is tenant-checked first, so this cannot be used to enumerate ids
   * belonging to another company.
   */
  private async jobScope(
    admin: AuthenticatedUser,
    jobId: string,
  ): Promise<Prisma.AuditLogWhereInput> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, companyId: admin.companyId },
      select: { id: true },
    });
    if (!job) throw new NotFoundException();

    const applications = await this.prisma.application.findMany({
      where: { jobId: job.id },
      select: { id: true },
    });
    const applicationIds = applications.map((a) => a.id);

    const [scorecards, matchScores] = await Promise.all([
      this.prisma.scorecard.findMany({
        where: { applicationId: { in: applicationIds } },
        select: { id: true },
      }),
      this.prisma.matchScore.findMany({
        where: { applicationId: { in: applicationIds } },
        select: { id: true },
      }),
    ]);

    return {
      resourceId: {
        in: [
          job.id,
          ...applicationIds,
          ...scorecards.map((s) => s.id),
          ...matchScores.map((m) => m.id),
        ],
      },
    };
  }

  async list(
    admin: AuthenticatedUser,
    query: QueryAuditDto,
  ): Promise<{ data: AuditEntry[]; nextCursor: string | null; totalCount: number }> {
    const where = await this.buildWhere(admin, query);
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    // AD-04 shows a result count and warns on large results, so the count is
    // part of the contract rather than a convenience.
    const [rows, totalCount] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: { actor: { select: { id: true, email: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    return {
      data,
      nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
      totalCount,
    };
  }

  /** GET /v1/audit-logs/:id — adds model provenance where one applies. */
  async findOne(admin: AuthenticatedUser, id: string): Promise<AuditEntryDetail> {
    const entry = await this.prisma.auditLog.findFirst({
      where: { id, companyId: admin.companyId },
      include: { actor: { select: { id: true, email: true } } },
    });
    if (!entry) throw new NotFoundException();

    /*
     * Gap 4: modelVersion is "present only where the entry references a
     * match_score". §9.3 step 4 is reconciliation against the model versions
     * active in a period, so provenance has to be visible here, not merely
     * stored (Phase 1 persona note).
     */
    if (entry.resourceType !== 'match_score') {
      return { entry, modelVersion: null, overrideReason: null };
    }

    const score = await this.prisma.matchScore.findUnique({
      where: { id: entry.resourceId },
      include: { modelVersion: { select: { modelName: true, versionTag: true } } },
    });

    return {
      entry,
      modelVersion: score
        ? `${score.modelVersion.modelName}@${score.modelVersion.versionTag}`
        : null,
      overrideReason: score?.overrideReason ?? null,
    };
  }

  /**
   * Every matching row, for export.
   *
   * Excludes `audit.exported` so an export never contains the record of an
   * export — including its own, which is written before the response
   * completes.
   */
  async findAllForExport(admin: AuthenticatedUser, query: QueryAuditDto): Promise<AuditEntry[]> {
    const where = await this.buildWhere(admin, query);

    return this.prisma.auditLog.findMany({
      where: {
        ...where,
        action: { not: EXPORT_ACTION, ...(query.actionType ? { equals: query.actionType } : {}) },
      },
      include: { actor: { select: { id: true, email: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
}
