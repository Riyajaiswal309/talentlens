import { Injectable, NotFoundException } from '@nestjs/common';
import type { MatchScore, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import type { OverrideScoreDto } from './dto/override-score.dto';

export interface ScoreOverrideResult {
  before: MatchScore;
  after: MatchScore;
}

@Injectable()
export class ScoreOverrideService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR4.3 — replace an AI score with a human judgement, with a reason.
   *
   * NEVER CREATES A SCORE. Phase 2 runs no model, so `match_scores` is empty
   * and every call here 404s. That is the correct outcome, not a gap to work
   * around: fabricating a row would require inventing a rationale and a
   * feature vector, which BR-02 and BR-07 exist to prevent. The Handoff puts
   * it plainly — "endpoint + audit + BR-03 validation in P2; live data in
   * P3".
   *
   * THE ORIGINAL SCORE IS PRESERVED. Phase 1 Flow 6 step 7: "the original AI
   * score remains visible alongside". `composite_score` is therefore left
   * untouched and the human value is recorded through `overridden_by` and
   * `override_reason`, which is also what makes the row auditable — an
   * override that erased what the model said would destroy the evidence
   * BR-03 asks for.
   *
   * Tenancy is reached through the job, as everywhere else: `applications`
   * has no company_id (PRD §17.2). Refusal is 404, never 403 (BR-06).
   */
  async override(
    user: AuthenticatedUser,
    applicationId: string,
    dto: OverrideScoreDto,
  ): Promise<ScoreOverrideResult> {
    const before = await this.prisma.matchScore.findFirst({
      where: {
        applicationId,
        application: { job: { companyId: user.companyId } },
      },
      // The current score is the most recent one (PRD §17.4 index).
      orderBy: { scoredAt: 'desc' },
    });

    if (!before) {
      /*
       * Indistinguishable from "no such application" and from "another
       * tenant's application" — all three are simply 404 with no detail, so
       * the endpoint cannot be used to learn which applications have been
       * scored.
       */
      throw new NotFoundException();
    }

    const after = await this.prisma.matchScore.update({
      where: { id: before.id },
      data: {
        overriddenBy: user.id,
        overrideReason: dto.reason.trim(),
      },
    });

    return { before, after };
  }
}

/**
 * Audit snapshots for an override (BR-03).
 *
 * The reason is carried in the after-state because `audit_logs` has no column
 * for it; Handoff §I requires the record to include `override_reason`, and
 * the state JSON is where it lives.
 */
export function toOverrideAuditState(
  result: ScoreOverrideResult,
  overrideScore: number,
): { before: Prisma.InputJsonValue; after: Prisma.InputJsonValue } {
  return {
    before: {
      matchScoreId: result.before.id,
      applicationId: result.before.applicationId,
      compositeScore: result.before.compositeScore.toString(),
      overridden: result.before.overriddenBy !== null,
      overrideReason: result.before.overrideReason,
    },
    after: {
      matchScoreId: result.after.id,
      applicationId: result.after.applicationId,
      // Unchanged — the model's value is retained alongside the override.
      compositeScore: result.after.compositeScore.toString(),
      overrideScore,
      overridden: true,
      overriddenBy: result.after.overriddenBy,
      overrideReason: result.after.overrideReason,
    },
  };
}
