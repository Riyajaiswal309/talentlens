import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ParseStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';

export interface ErasureResult {
  candidateId: string;
  applicationsRetained: number;
  resumesDetached: number;
  erasedAt: Date;
}

/**
 * BR-05 — "Candidate data may only be used for the hiring purpose for which
 * it was collected, and must be deletable on request."
 *
 * PRD §17.1 and §18 fix the mechanism exactly: "soft-delete via `deleted_at`
 * on candidate-facing entities; erasure routine detaches PII while preserving
 * audit referential integrity", and "erasing a candidate detaches PII while
 * leaving the audit skeleton intact".
 *
 * So this is NOT a delete. Applications, stage history, scorecards and the
 * audit trail all survive — what happened stays reconstructable — while the
 * columns that identify a person are overwritten. A hard delete would take
 * the audit trail with it and break the very guarantee §17.3 exists for.
 */
@Injectable()
export class CandidateErasureService {
  private readonly logger = new Logger(CandidateErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Erase one candidate's PII.
   *
   * Tenancy is reached through the candidate's applications: `candidates`
   * carries no company_id (PRD §17.2), so a candidate is "in" a tenant only
   * by having applied to one of its jobs. Refusal is 404, never 403 (BR-06).
   */
  async erase(admin: AuthenticatedUser, candidateId: string): Promise<ErasureResult> {
    const candidate = await this.prisma.candidate.findFirst({
      where: {
        id: candidateId,
        deletedAt: null,
        applications: { some: { job: { companyId: admin.companyId } } },
      },
      include: { applications: { include: { resume: true } } },
    });

    if (!candidate) throw new NotFoundException();

    const resumeKeys = candidate.applications
      .map((application) => application.resume?.s3Key)
      .filter((key): key is string => Boolean(key));

    const erasedAt = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      /*
       * Overwrite rather than null: full_name and email are NOT NULL, and a
       * placeholder that is obviously a tombstone reads better in a recruiter
       * view than an empty row. The id is retained so every foreign key —
       * applications, and through them stage_history and audit_logs — stays
       * valid, which is the "audit skeleton" §18 requires.
       */
      const erased = await tx.candidate.update({
        where: { id: candidate.id },
        data: {
          fullName: 'Erased candidate',
          email: `erased+${candidate.id}@invalid`,
          phone: null,
          // The login link goes too; the account can no longer reach the data.
          userId: null,
          deletedAt: erasedAt,
          erasedBy: admin.id,
        },
      });

      // The parsed profile is extracted PII. The resume row itself is kept so
      // the application remains coherent, with its storage pointer cleared.
      await tx.parsedProfile.deleteMany({
        where: { resume: { application: { candidateId: candidate.id } } },
      });

      await tx.resume.updateMany({
        where: { application: { candidateId: candidate.id } },
        data: { s3Key: '', parseStatus: ParseStatus.FAILED },
      });

      return erased;
    });

    /*
     * The stored files go last and outside the transaction: an S3 delete
     * cannot be rolled back, so it must not run until the database has
     * committed. deleteQuietly swallows its own failure — a surviving object
     * with no row pointing at it is recoverable; a rolled-back erasure that
     * had already destroyed the file would not be.
     */
    for (const key of resumeKeys) {
      await this.storage.deleteQuietly(key);
    }

    this.logger.log(`BR-05: erased candidate ${candidate.id} (${resumeKeys.length} file(s))`);

    return {
      candidateId: result.id,
      applicationsRetained: candidate.applications.length,
      resumesDetached: resumeKeys.length,
      erasedAt,
    };
  }

  /** Snapshot for the audit record. Carries no PII — that is the point. */
  static toAuditState(result: ErasureResult): Prisma.InputJsonValue {
    return {
      candidateId: result.candidateId,
      applicationsRetained: result.applicationsRetained,
      resumesDetached: result.resumesDetached,
      erasedAt: result.erasedAt.toISOString(),
    } as Prisma.InputJsonValue;
  }
}
