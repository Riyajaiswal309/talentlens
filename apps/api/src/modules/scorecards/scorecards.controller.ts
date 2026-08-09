import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { CreateScorecardDto } from './dto/create-scorecard.dto';
import { ScorecardsService, type ScorecardWithAuthor } from './scorecards.service';

/** Phase 1 RC-13 — ratings, feedback and the author list. */
interface ScorecardResponse {
  id: string;
  rating: number;
  feedback: string | null;
  author: {
    id: string;
    email: string;
    role: string;
  };
  submittedAt: string;
}

function toResponse(scorecard: ScorecardWithAuthor): ScorecardResponse {
  return {
    id: scorecard.id,
    rating: scorecard.rating,
    feedback: scorecard.feedback,
    author: {
      id: scorecard.author.id,
      email: scorecard.author.email,
      role: scorecard.author.role,
    },
    submittedAt: scorecard.createdAt.toISOString(),
  };
}

/**
 * FR5.3 — structured interviewer feedback.
 *
 * Recruiter, Hiring Manager and Admin, per PRD §24.2 ("Submit scorecard:
 * Recruiter ✓, Hiring Manager ✓, Admin ✓") and Handoff §B row 18.
 *
 * CANDIDATES ARE ABSENT FROM BOTH ROUTES AND THAT IS THE POINT. A scorecard
 * is the hiring team's assessment OF the candidate; BR-06 governs a
 * candidate's access to their own data, and this is not it. Nothing here is
 * reachable by the person being assessed.
 *
 * Neither route is audited: Handoff §I's action vocabulary has no scorecard
 * event, and inventing one would extend a list the Handoff fixes on purpose.
 */
@Controller('applications')
export class ScorecardsController {
  constructor(private readonly scorecards: ScorecardsService) {}

  /** POST /v1/applications/:id/scorecards (Handoff §B row 18). */
  @Post(':id/scorecards')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateScorecardDto,
  ): Promise<ScorecardResponse> {
    return toResponse(await this.scorecards.create(user, id, dto));
  }

  /**
   * GET /v1/applications/:id/scorecards — the FR5.3 read path.
   *
   * NOT in PRD §23.2 or Handoff §B; it belongs on the D4 amendment list.
   * Phase 1 states the FR5.3 criterion as "scorecards listed on candidate
   * detail", but Handoff row 13 excludes Hiring Managers from
   * GET /v1/applications/:id — so serving them there would withhold team
   * visibility from the role HM-03 shows it to. Same path and same roles as
   * the POST is the smallest shape that satisfies the requirement.
   */
  @Get(':id/scorecards')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: ScorecardResponse[] }> {
    const scorecards = await this.scorecards.listForApplication(user, id);
    return { data: scorecards.map(toResponse) };
  }
}
