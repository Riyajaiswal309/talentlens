import { Injectable, Logger } from '@nestjs/common';
import { AiScoringPort, type ScoreResult } from './ai-scoring.port';

/**
 * The Phase 2 implementation of the AI seam (Handoff §G).
 *
 * "Phase 2 supplies NullAiProvider: requestParse is a no-op; getScore always
 * returns NotScored."
 *
 * This is not a stub awaiting completion — it is the specified Phase 2
 * behaviour. No model runs, so there is genuinely nothing to report, and
 * saying so plainly is more truthful than inventing a placeholder score.
 * Because it is the only implementation, every consumer is written against
 * the not-scored path from the first day, which is the FR4.5 / BR-02
 * rendering the UI has to get right.
 */
@Injectable()
export class NullAiProvider extends AiScoringPort {
  private readonly logger = new Logger(NullAiProvider.name);

  constructor() {
    super();
    this.logger.warn(
      'AI scoring is the NULL provider — no scores are generated and getScore always returns NotScored (Handoff §G)',
    );
  }

  /**
   * No-op.
   *
   * Nothing calls this in Phase 2: intake publishes `resume.uploaded` to
   * BullMQ itself (PRD §23.1, M2.7 step 4) and that path is untouched. The
   * method exists because Handoff §G fixes it as part of the contract.
   */
  requestParse(resumeId: string): Promise<void> {
    this.logger.debug(`requestParse ignored for resume=${resumeId} (null provider)`);
    return Promise.resolve();
  }

  /** Always NotScored — there is no model and no match_scores row to read. */
  getScore(applicationId: string): Promise<ScoreResult> {
    this.logger.debug(`getScore -> NotScored for application=${applicationId}`);
    return Promise.resolve({ scored: false });
  }
}
