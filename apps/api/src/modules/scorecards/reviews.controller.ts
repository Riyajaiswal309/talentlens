import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { ListReviewsQueryDto } from './dto/list-reviews.query.dto';
import { ScorecardsService, type ReviewItem } from './scorecards.service';

/** Handoff Gap 1 response row. */
interface ReviewResponse {
  applicationId: string;
  jobId: string;
  jobTitle: string;
  candidateName: string;
  requestedAt: string;
  scorecardSubmitted: boolean;
}

function toResponse(item: ReviewItem): ReviewResponse {
  return {
    applicationId: item.applicationId,
    jobId: item.jobId,
    jobTitle: item.jobTitle,
    candidateName: item.candidateName,
    requestedAt: item.requestedAt.toISOString(),
    scorecardSubmitted: item.scorecardSubmitted,
  };
}

/**
 * GET /v1/me/reviews — Hiring Manager, Administrator
 * (Handoff §B row 19 / Gap 1, Phase 1 HM-01).
 *
 * A distinct `me` prefix rather than a route on `applications`, because the
 * resource is the caller's own queue rather than any one application. It does
 * not collide with `/v1/auth/me`, which lives under the `auth` prefix.
 *
 * RECRUITERS AND CANDIDATES ARE EXCLUDED, as Gap 1 requires (403). A
 * recruiter's view of outstanding work is the pipeline board, not a personal
 * review queue.
 *
 * Not audited: reads are not state changes (PRD §17.3).
 */
@Controller('me')
export class ReviewsController {
  constructor(private readonly scorecards: ScorecardsService) {}

  @Get('reviews')
  @Roles(UserRole.HIRING_MANAGER, UserRole.ADMIN)
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListReviewsQueryDto,
  ): Promise<{ data: ReviewResponse[]; nextCursor: string | null }> {
    const { data, nextCursor } = await this.scorecards.listReviews(user, query);
    return { data: data.map(toResponse), nextCursor };
  }
}
