import { Module } from '@nestjs/common';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
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
 * Both halves of FR5.3 now live here: scorecards (M2.8) and comments, which
 * had no table until the remaining-gaps pass and left the requirement half
 * delivered despite the Handoff marking it "✅ Full".
 *
 * ReviewsController serves GET /v1/me/reviews (Handoff §B row 19), which the
 * Handoff assigns to this module even though its path is not under
 * `applications`.
 */
@Module({
  controllers: [ScorecardsController, ReviewsController, CommentsController],
  providers: [ScorecardsService, CommentsService],
  exports: [ScorecardsService],
})
export class ScorecardsModule {}
