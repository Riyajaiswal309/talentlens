import { Body, Controller, Param, ParseUUIDPipe, Patch, Req } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { AiScoringAdminService } from './ai-scoring.service';
import { SetAiScoringDto } from './dto/ai-scoring.dto';

interface AiScoringResponse {
  jobId: string;
  title: string;
  aiScoringEnabled: boolean;
  /** FR4.5 — what turning it off means, so AD-03 can show the consequence. */
  effect: string;
}

/**
 * FR8.2 / BR-04 — the per-job AI toggle
 * (PRD §23.2, Handoff §B row 24, Phase 1 AD-03).
 *
 * BR-04: "Administrators, not individual recruiters, control whether AI
 * scoring is enabled for a given requisition." The PRD names this exact
 * route as the enforcement point, and @Roles(ADMIN) is it. The rule is
 * doubly enforced: every recruiter-facing job DTO omits `aiScoringEnabled`,
 * so `forbidNonWhitelisted` already rejects it on the ordinary edit routes.
 */
@ApiTags('admin')
@Controller('admin/jobs')
export class AiScoringController {
  constructor(private readonly aiScoring: AiScoringAdminService) {}

  @Patch(':id/ai-scoring')
  @Roles(UserRole.ADMIN)
  @Audit({ action: 'admin.ai_scoring_changed', resourceType: 'job' })
  @ApiOperation({ summary: 'Enable or disable AI scoring for a job (FR8.2, BR-04)' })
  async setAiScoring(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetAiScoringDto,
    @Req() req: RequestContext,
  ): Promise<AiScoringResponse> {
    const { before, after } = await this.aiScoring.setEnabled(admin, id, dto.enabled);

    req.auditState = {
      before: { jobId: before.id, aiScoringEnabled: before.aiScoringEnabled },
      after: { jobId: after.id, aiScoringEnabled: after.aiScoringEnabled },
    };

    return {
      jobId: after.id,
      title: after.title,
      aiScoringEnabled: after.aiScoringEnabled,
      effect: after.aiScoringEnabled
        ? 'Candidates will be ranked once scoring is available.'
        : 'Candidates are listed newest first with no score (FR4.5).',
    };
  }
}
