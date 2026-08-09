import { Module } from '@nestjs/common';
import { ReviewsController } from './reviews.controller';
import { ScorecardsController } from './scorecards.controller';
import { ScorecardsService } from './scorecards.service';

/**
 * FR5.3 — scorecards.
 *
 * Kept separate from PipelineModule (Handoff §H [PROP], approved 9 Aug 2026)
 * even though PRD §15.3 groups them: stage movement and interviewer feedback
 * have different role matrices, and separating them keeps each authorisation
 * story readable in one file.
 *
 * Comments — the other half of FR5.3 — have no table in the schema and are a
 * recorded Phase 2 shortfall, not an omission here.
 *
 * ReviewsController serves GET /v1/me/reviews (Handoff §B row 19), which the
 * Handoff assigns to this module even though its path is not under
 * `applications`.
 */
@Module({
  controllers: [ScorecardsController, ReviewsController],
  providers: [ScorecardsService],
  exports: [ScorecardsService],
})
export class ScorecardsModule {}
