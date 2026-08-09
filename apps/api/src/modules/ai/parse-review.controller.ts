import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { ParseReviewQueryDto, PatchParsedProfileDto } from './dto/parse-review.dto';
import { ParseReviewService, type ReviewItem } from './parse-review.service';

/**
 * FR3.2 — the parse review queue (Handoff Gap 3, Phase 1 RC-14).
 *
 * Recruiter and Administrator. Hiring Managers are excluded: §24.2 gives
 * them read access to rankings and no correction rights anywhere.
 */
@ApiTags('parsing')
@Controller('jobs')
export class ParseReviewController {
  constructor(private readonly review: ParseReviewService) {}

  @Get(':id/parse-review')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Fields the parser flagged for review (FR3.2, §20 stage 5)' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ParseReviewQueryDto,
  ): Promise<{ data: ReviewItem[]; nextCursor: string | null }> {
    return this.review.listForJob(user, id, query);
  }
}

/**
 * PATCH /v1/parsed-profiles/:id — FR2.2 / FR3.2.
 *
 * Candidates are included here and nowhere else in the AI surface: FR2.2
 * gives them the right to correct their own auto-filled data, and Gap 3
 * scopes that to a profile on their own application.
 */
@ApiTags('parsing')
@Controller('parsed-profiles')
export class ParsedProfilesController {
  constructor(private readonly review: ParseReviewService) {}

  @Patch(':id')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN, UserRole.CANDIDATE)
  @Audit({ action: 'parsed_profile.corrected', resourceType: 'parsed_profile' })
  @ApiOperation({ summary: 'Correct or confirm extracted fields (FR2.2, FR3.2)' })
  async patch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchParsedProfileDto,
    @Req() req: RequestContext,
  ): Promise<{ id: string; confirmedFields: string[] }> {
    const { before, after, confirmed } = await this.review.patch(user, id, dto.fields);

    req.auditState = {
      before: { fieldConfidence: before.fieldConfidence },
      after: { fieldConfidence: after.fieldConfidence, confirmedFields: confirmed },
    };

    return { id: after.id, confirmedFields: confirmed };
  }
}
