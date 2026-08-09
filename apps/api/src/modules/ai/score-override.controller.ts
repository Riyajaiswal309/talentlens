import { Body, Controller, Param, ParseUUIDPipe, Patch, Req } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { AI_AUDIT_ACTIONS } from './ai-audit-actions';
import { OverrideScoreDto } from './dto/override-score.dto';
import { ScoreOverrideService, toOverrideAuditState } from './score-override.service';

/** Phase 1 RC-07 / API table row: `overridden`, `overriddenBy`, `originalScore`. */
interface OverrideScoreResponse {
  applicationId: string;
  matchScoreId: string;
  overridden: true;
  overriddenBy: string;
  /** PRD §15.4: the override does not replace the AI value — both remain. */
  originalScore: number;
  overrideScore: number;
  reason: string;
}

/**
 * PATCH /v1/applications/:id/score — Recruiter, Admin
 * (PRD §23.2, Handoff §B row 17, FR4.3, BR-03).
 *
 * Lives in AiModule rather than ApplicationsModule: the resource is an AI
 * score, and keeping it beside the seam means the whole AI surface — port,
 * provider, audit vocabulary, override — is one directory. The Handoff lists
 * the row under "Applications" by path, not by ownership.
 *
 * HIRING MANAGERS ARE EXCLUDED. PRD §24.2 Table 24.1: "Override AI score —
 * Recruiter ✓, Hiring Manager —", and Phase 1 HM-03 says "no override
 * control visible anywhere".
 *
 * PHASE 2 REALITY: no model runs, so `match_scores` is empty and every call
 * returns 404. The endpoint, its authorisation, its BR-03 validation and its
 * audit wiring all exist and are tested; only live data is missing, exactly
 * as the Handoff describes FR4.3.
 */
@Controller('applications')
export class ScoreOverrideController {
  constructor(private readonly overrides: ScoreOverrideService) {}

  @Patch(':id/score')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @Audit({ action: AI_AUDIT_ACTIONS.SCORE_OVERRIDDEN, resourceType: 'match_score' })
  async override(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OverrideScoreDto,
    @Req() req: RequestContext,
  ): Promise<OverrideScoreResponse> {
    const result = await this.overrides.override(user, id, dto);

    /*
     * The audit record is about the SCORE, not the application, so the
     * interceptor is pointed at the match_score id. Handoff Gap 4's audit
     * reader surfaces `modelVersion` "only where the entry references a
     * match_score", which depends on this.
     */
    req.params = { ...req.params, id: result.after.id };
    req.auditState = toOverrideAuditState(result, dto.overrideScore);

    return {
      applicationId: result.after.applicationId,
      matchScoreId: result.after.id,
      overridden: true,
      overriddenBy: user.id,
      originalScore: Number(result.before.compositeScore),
      overrideScore: dto.overrideScore,
      reason: result.after.overrideReason ?? dto.reason,
    };
  }
}
