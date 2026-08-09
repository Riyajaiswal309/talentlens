import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { assertAllowedFeatures } from './feature-allow-list';
import {
  DEFAULT_RANKING_WEIGHTS,
  WEIGHT_SUM_TOLERANCE,
  type RankingWeights,
} from './dto/ranking-weights.dto';

/** Gap 2 response — `rescoreStatus` reports what the write triggered. */
export type RescoreStatus = 'queued' | 'not_applicable';

export interface WeightsView {
  weights: RankingWeights;
  isDefault: boolean;
  updatedAt: Date | null;
}

export interface WeightsWriteResult extends WeightsView {
  affectedApplicationCount: number;
  rescoreStatus: RescoreStatus;
}

@Injectable()
export class RankingWeightsService {
  constructor(private readonly prisma: PrismaService) {}

  private async findJob(user: AuthenticatedUser, jobId: string) {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, companyId: user.companyId },
    });
    // 404, never 403 — a 403 would confirm the job exists elsewhere (BR-06).
    if (!job) throw new NotFoundException();
    return job;
  }

  /** GET — the job's weights, or the documented defaults. */
  async get(user: AuthenticatedUser, jobId: string): Promise<WeightsView> {
    const job = await this.findJob(user, jobId);
    const stored = job.rankingWeights as RankingWeights | null;

    return {
      weights: stored ?? DEFAULT_RANKING_WEIGHTS,
      isDefault: stored === null,
      updatedAt: job.rankingWeightsUpdatedAt,
    };
  }

  /**
   * PUT — FR4.2, "Recruiters can adjust ranking weights per job".
   *
   * BR-07 is enforced twice over: the DTO's fixed properties reject an
   * unknown key at the pipe, and `assertAllowedFeatures` re-checks the
   * assembled object. The rule the Handoff attaches to this endpoint is the
   * one that keeps a protected attribute out of the model, so it is not left
   * to a single layer.
   */
  async set(
    user: AuthenticatedUser,
    jobId: string,
    weights: RankingWeights,
  ): Promise<WeightsWriteResult> {
    const job = await this.findJob(user, jobId);

    // Gap 2 error table — a closed requisition is not re-weighted.
    if (job.status === JobStatus.CLOSED) {
      throw new ConflictException('Ranking weights cannot be changed on a closed job');
    }

    assertAllowedFeatures(weights as unknown as Record<string, unknown>);

    const sum = Object.values(weights).reduce((total, value) => total + value, 0);
    if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
      throw new BadRequestException(`Weights must sum to 1.0 (received ${sum.toFixed(4)})`);
    }

    const updated = await this.prisma.job.update({
      where: { id: job.id },
      data: { rankingWeights: weights, rankingWeightsUpdatedAt: new Date() },
    });

    const affectedApplicationCount = await this.prisma.application.count({
      where: { jobId: job.id },
    });

    /*
     * §21.3 re-scores the pool against the new weighting. Nothing scores in
     * this build — there is no trained model — so the honest report is
     * `not_applicable` whenever scoring is off, per decision D9's
     * recommendation, and `queued` only where the job has AI enabled and a
     * scorer would pick the work up.
     */
    return {
      weights,
      isDefault: false,
      updatedAt: updated.rankingWeightsUpdatedAt,
      affectedApplicationCount,
      rescoreStatus: job.aiScoringEnabled ? 'queued' : 'not_applicable',
    };
  }
}
