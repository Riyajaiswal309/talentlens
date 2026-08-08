import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { UserRole, type Job } from '@prisma/client';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JobScoped } from '../../common/decorators/resource-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { CreateJobDto } from './dto/create-job.dto';
import { ListJobsQueryDto } from './dto/list-jobs.query.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { JobsService, toAuditSnapshot } from './jobs.service';

/** Response shape. Internal columns stay internal. */
interface JobResponse {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  employmentType: string | null;
  experienceLevel: string | null;
  description: string | null;
  requiredSkills: unknown;
  status: string;
  /** Read-only here — only an Administrator can change it (FR1.4, BR-04). */
  aiScoringEnabled: boolean;
  publishedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toResponse(job: Job): JobResponse {
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
    aiScoringEnabled: job.aiScoringEnabled,
    publishedAt: job.publishedAt?.toISOString() ?? null,
    closedAt: job.closedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /** POST /v1/jobs — Recruiter, Admin (Handoff §B row 5). FR1.1, FR1.2. */
  @Post()
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @Audit({ action: 'job.created', resourceType: 'job' })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateJobDto,
    @Req() req: RequestContext,
  ): Promise<JobResponse> {
    const job = await this.jobs.create(user, dto);
    // No prior state on create; AuditInterceptor writes this before the
    // response is emitted (PRD §15.1 principle 4).
    req.auditState = { before: null, after: toAuditSnapshot(job) };
    return toResponse(job);
  }

  /**
   * GET /v1/jobs — Recruiter, HM, Admin (Handoff §B row 6).
   *
   * A Hiring Manager receives only assigned jobs; the narrowing happens in
   * JobsService because a list has no :id for JobAssignmentGuard to inspect.
   */
  @Get()
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListJobsQueryDto,
  ): Promise<{ data: JobResponse[]; nextCursor: string | null }> {
    const { data, nextCursor } = await this.jobs.list(user, query);
    return { data: data.map(toResponse), nextCursor };
  }

  /**
   * GET /v1/jobs/:id — Recruiter, HM, Admin.
   *
   * @JobScoped() hands the route to JobAssignmentGuard, which proves the job
   * is in the caller's tenant and, for a Hiring Manager, that they are
   * assigned to it. Both refusals are 404.
   */
  @Get(':id')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @JobScoped()
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobResponse> {
    return toResponse(await this.jobs.findOne(user, id));
  }

  /** PATCH /v1/jobs/:id — edit, publish or close (Handoff §B row 8). FR1.1. */
  @Patch(':id')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @JobScoped()
  @Audit({ action: 'job.updated', resourceType: 'job' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateJobDto,
    @Req() req: RequestContext,
  ): Promise<JobResponse> {
    const { before, after } = await this.jobs.update(user, id, dto);
    req.auditState = { before: toAuditSnapshot(before), after: toAuditSnapshot(after) };
    return toResponse(after);
  }

  /** POST /v1/jobs/:id/duplicate — Recruiter, Admin (Handoff §B row 9). FR1.3. */
  @Post(':id/duplicate')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @JobScoped()
  @Audit({ action: 'job.duplicated', resourceType: 'job' })
  @HttpCode(HttpStatus.CREATED)
  async duplicate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestContext,
  ): Promise<JobResponse> {
    const copy = await this.jobs.duplicate(user, id);

    /*
     * The audit record must identify the NEW job, not the template, so the
     * interceptor's default of reading :id from the route would be wrong
     * here. Setting params.id redirects it to the copy.
     */
    req.params.id = copy.id;
    req.auditState = { before: null, after: toAuditSnapshot(copy) };

    return toResponse(copy);
  }
}
