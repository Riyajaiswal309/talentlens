import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { ListPublicJobsQueryDto } from './dto/list-public-jobs.query.dto';
import { JobsService } from './jobs.service';

/**
 * What an anonymous caller may see of a job.
 *
 * A separate shape from the authenticated JobResponse, not a subset computed
 * at runtime. Two things are withheld deliberately:
 *
 *   - `aiScoringEnabled` — FR1.4/BR-04 make this an Administrator-only
 *     setting. Publishing it would tell the world which roles are screened by
 *     AI, which is a disclosure the PRD never authorises here.
 *   - `companyId`, `createdBy`, `createdAt`, `updatedAt` — internal
 *     bookkeeping that tells a candidate nothing and links roles to the
 *     tenant that owns them.
 *
 * Keeping the type separate means a column added to `jobs` later cannot leak
 * by being picked up automatically.
 */
interface PublicJobResponse {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  employmentType: string | null;
  experienceLevel: string | null;
  description: string | null;
  requiredSkills: unknown;
  /** CA-01 renders a distinct state for a closed role. */
  status: string;
  publishedAt: string | null;
  closedAt: string | null;
}

function toPublicResponse(job: Job): PublicJobResponse {
  return {
    id: job.id,
    title: job.title,
    department: job.department,
    location: job.location,
    employmentType: job.employmentType,
    experienceLevel: job.experienceLevel,
    description: job.description,
    requiredSkills: job.requiredSkills,
    status: job.status,
    publishedAt: job.publishedAt?.toISOString() ?? null,
    closedAt: job.closedAt?.toISOString() ?? null,
  };
}

/**
 * The public job board (Phase 1 CA-01, Handoff §B rows 10–11).
 *
 * Both routes are @Public(): a candidate discovers and reads a role before
 * they have any account. Neither is audited — PRD §17.3 records actions that
 * change state, and an anonymous page view is not one.
 */
@Controller('public/jobs')
export class PublicJobsController {
  constructor(private readonly jobs: JobsService) {}

  /** GET /v1/public/jobs — published roles, newest first. */
  @Public()
  @Get()
  async list(
    @Query() query: ListPublicJobsQueryDto,
  ): Promise<{ data: PublicJobResponse[]; nextCursor: string | null }> {
    const { data, nextCursor } = await this.jobs.listPublic(query);
    return { data: data.map(toPublicResponse), nextCursor };
  }

  /**
   * GET /v1/public/jobs/:id — one role.
   *
   * ParseUUIDPipe rejects a malformed id as 400 before it reaches the
   * database, so this cannot be used to probe with arbitrary strings.
   */
  @Public()
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<PublicJobResponse> {
    return toPublicResponse(await this.jobs.findOnePublic(id));
  }
}
