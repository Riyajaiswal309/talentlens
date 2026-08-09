import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { SetRankingWeightsDto, type RankingWeights } from './dto/ranking-weights.dto';
import { RankingWeightsService } from './ranking-weights.service';

/**
 * FR4.2 — per-job ranking weights (Handoff §B / Gap 2).
 *
 * Recruiter and Administrator only. PRD §24.2 gives Hiring Managers a
 * read-only view of rankings and no tuning rights, and a Candidate none at
 * all, so both are refused by RolesGuard.
 */
@ApiTags('ranking')
@Controller('jobs')
export class RankingWeightsController {
  constructor(private readonly weights: RankingWeightsService) {}

  @Get(':id/ranking-weights')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Current ranking weights for a job (FR4.2)' })
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ weights: RankingWeights; isDefault: boolean; updatedAt: string | null }> {
    const view = await this.weights.get(user, id);
    return { ...view, updatedAt: view.updatedAt?.toISOString() ?? null };
  }

  @Put(':id/ranking-weights')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @Audit({ action: 'job.ranking_weights_changed', resourceType: 'job' })
  @ApiOperation({
    summary: 'Set ranking weights (FR4.2, BR-07)',
    description: 'Exactly the six PRD Table 19.1 features, each in [0,1], summing to 1.0.',
  })
  async set(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRankingWeightsDto,
    @Req() req: RequestContext,
  ): Promise<{
    weights: RankingWeights;
    affectedApplicationCount: number;
    rescoreStatus: string;
  }> {
    const before = await this.weights.get(user, id);
    const result = await this.weights.set(user, id, dto.weights as RankingWeights);

    req.auditState = {
      before: { weights: before.weights, isDefault: before.isDefault },
      after: { weights: result.weights, rescoreStatus: result.rescoreStatus },
    };

    return {
      weights: result.weights,
      affectedApplicationCount: result.affectedApplicationCount,
      rescoreStatus: result.rescoreStatus,
    };
  }
}
