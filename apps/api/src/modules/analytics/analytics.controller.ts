import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { AnalyticsService, type FunnelReport } from './analytics.service';
import { FunnelQueryDto } from './dto/funnel-query.dto';

/**
 * FR7.1–FR7.2 — the hiring funnel (PRD §23.2, Phase 1 RC-12).
 *
 * Recruiter and Administrator, exactly as PRD Table 23.1 and RC-12's role
 * column state. HIRING MANAGERS ARE EXCLUDED and that is the specified
 * position, not a tightening: §24.2 scopes them to assigned jobs, and a
 * tenant-wide funnel is by definition wider than any assignment. A Hiring
 * Manager receives 403 from RolesGuard — a role refusal, unlike a foreign
 * `jobId`, which is 404 because it would otherwise disclose that the job
 * exists somewhere (BR-06).
 *
 * Not audited: Handoff §I Table I.1 lists no analytics event, and PRD §17.3
 * records actions that change state. Reading a dashboard is not one.
 */
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** GET /v1/analytics/funnel (PRD §23.2 Table 23.1). */
  @Get('funnel')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  async funnel(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FunnelQueryDto,
  ): Promise<FunnelReport> {
    return this.analytics.funnel(user, query);
  }
}
