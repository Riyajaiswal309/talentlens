import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ResumeQueueService } from '../../common/queue/resume-queue.service';
import { AiScoringPort, type ScoreResult } from './ai-scoring.port';

/**
 * The Phase 3 implementation of the AI seam.
 *
 * ON THE NAME: the plan called this `AiHttpProvider`, but neither port method
 * makes an HTTP call and naming it so would misdescribe it.
 *
 *   getScore     reads the persisted `match_scores` row
 *   requestParse publishes to the queue — Handoff §G, "fire-and-forget, queued"
 *
 * The HTTP boundary to the Python service lives in the WORKER, exactly where
 * PRD §23.1's sequence puts it (`Q->>W`, then `W->>AI`). Putting it here
 * would make a recruiter's page load wait on a model, which §15.1 forbids.
 *
 * Replaces NullAiProvider. Where no score exists — every application until a
 * model actually runs — it still answers NotScored, so the FR4.5 path stays
 * live rather than becoming dead code.
 */
@Injectable()
export class PersistedAiProvider extends AiScoringPort {
  private readonly logger = new Logger(PersistedAiProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ResumeQueueService,
  ) {
    super();
  }

  /** Handoff §G — queued, never awaited by a request path. */
  async requestParse(resumeId: string): Promise<void> {
    await this.queue.publishResumeUploaded({
      resumeId,
      correlationId: `requestParse-${resumeId}`,
    });
  }

  /**
   * The current score for an application (PRD §23.3 shape).
   *
   * Reads the most recent `match_scores` row — PRD §17.4's index exists for
   * this. Returns rather than throws when there is none: §15.1 requires an
   * absent model to leave the recruiter workflow intact.
   */
  async getScore(applicationId: string): Promise<ScoreResult> {
    const score = await this.prisma.matchScore.findFirst({
      where: { applicationId },
      orderBy: { scoredAt: 'desc' },
      include: { modelVersion: { select: { modelName: true, versionTag: true } } },
    });

    if (!score) return { scored: false };

    /*
     * BR-02 — "a score without an explanation may not be surfaced". The
     * column is NOT NULL, so this should be unreachable; if a row ever did
     * arrive without one it is withheld rather than rendered bare.
     */
    const rationale = score.rationale as { summary?: string; factors?: unknown[] } | null;
    if (!rationale?.summary) {
      this.logger.error(`BR-02: match_score ${score.id} has no rationale; withholding`);
      return { scored: false };
    }

    return {
      scored: true,
      composite: Number(score.compositeScore),
      modelVersion: `${score.modelVersion.modelName}@${score.modelVersion.versionTag}`,
      rationale: rationale as { summary: string; factors: [] },
      overridden: score.overriddenBy !== null,
    };
  }
}
