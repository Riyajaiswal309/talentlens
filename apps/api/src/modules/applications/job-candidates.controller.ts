import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JobScoped } from '../../common/decorators/resource-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { AiScoringPort } from '../ai/ai-scoring.port';
import { toWireScore, type WireScore } from '../ai/score-view';
import { ApplicationsService, type JobCandidate } from './applications.service';
import { ListJobCandidatesQueryDto } from './dto/list-job-candidates.query.dto';

/**
 * One row of the RC-05 candidate list, shaped as PRD §23.3 specifies.
 *
 * `score` comes from AiScoringPort. In Phase 2 the null provider always
 * answers NotScored, so it renders as null — the FR4.5 rendering, which the
 * Handoff calls "the P2 rendering" rather than a temporary gap. The value is
 * resolved through the seam rather than hard-coded, so Phase 3 populates it
 * without touching this file.
 */
interface JobCandidateResponse {
  applicationId: string;
  candidate: {
    fullName: string;
    email: string;
  };
  currentStage: string;
  appliedAt: string;
  /** Always PENDING in Phase 2 (FR2.5) — nothing parses yet. */
  parseStatus: string | null;
  score: WireScore | null;
}

function toResponse(application: JobCandidate, score: WireScore | null): JobCandidateResponse {
  return {
    applicationId: application.id,
    candidate: {
      fullName: application.candidate.fullName,
      email: application.candidate.email,
    },
    currentStage: application.currentStage,
    appliedAt: application.appliedAt.toISOString(),
    parseStatus: application.resume?.parseStatus ?? null,
    score,
  };
}

/**
 * GET /v1/jobs/:id/candidates (Handoff §B row 14, module Applications).
 *
 * A separate controller under the `jobs` prefix because the Handoff assigns
 * this route to the Applications module while its path belongs to jobs.
 * Nest routes `jobs/:id` and `jobs/:id/candidates` distinctly, so this does
 * not collide with JobsController.
 */
@Controller('jobs')
export class JobCandidatesController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly ai: AiScoringPort,
  ) {}

  /**
   * Recruiter, Hiring Manager, Admin.
   *
   * @JobScoped() hands the route to JobAssignmentGuard, which proves the job
   * is in the caller's tenant and, for a Hiring Manager, that they are
   * assigned to it (decision B1). Both refusals are 404, never 403 — a 403
   * would confirm the job id exists in another tenant (BR-06).
   *
   * Not audited: this is a read.
   */
  @Get(':id/candidates')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @JobScoped()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListJobCandidatesQueryDto,
  ): Promise<{ data: JobCandidateResponse[]; nextCursor: string | null }> {
    const { data, nextCursor } = await this.applications.listForJob(user, id, query);

    /*
     * One getScore per row. Handoff §G defines no batch method and inventing
     * one would widen the contract Phase 3 must satisfy; the page is capped
     * at 100 by the DTO, and the null provider does no I/O.
     */
    const rows = await Promise.all(
      data.map(async (application) =>
        toResponse(application, toWireScore(await this.ai.getScore(application.id))),
      ),
    );

    return { data: rows, nextCursor };
  }
}
