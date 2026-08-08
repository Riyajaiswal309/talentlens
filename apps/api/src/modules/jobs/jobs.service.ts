import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { type Job, JobStatus, type Prisma, UserRole } from '@prisma/client';
import { DEFAULT_PIPELINE_STAGES } from '@talentlens/shared-types';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import type { CreateJobDto } from './dto/create-job.dto';
import type { ListJobsQueryDto } from './dto/list-jobs.query.dto';
import type { UpdateJobDto } from './dto/update-job.dto';

/** Stages that terminate an application (BR-01 — human confirmation required). */
const TERMINAL_STAGES = new Set(['Hired', 'Rejected']);

const DEFAULT_PAGE_SIZE = 25;

/**
 * Legal status moves (FR1.1 — "create, edit, publish, and close").
 *
 * CLOSED is terminal: the PRD describes closing a requisition but never
 * reopening one, so that transition is refused rather than invented.
 * PUBLISHED -> DRAFT is likewise absent from the PRD and refused: a job that
 * has been publicly visible cannot quietly become a draft again.
 */
const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  [JobStatus.DRAFT]: [JobStatus.PUBLISHED, JobStatus.CLOSED],
  [JobStatus.PUBLISHED]: [JobStatus.CLOSED],
  [JobStatus.CLOSED]: [],
};

/** Snapshot written to audit_logs before/after state (PRD §17.3). */
export function toAuditSnapshot(job: Job): Prisma.InputJsonValue {
  return {
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
  } as Prisma.InputJsonValue;
}

@Injectable()
export class JobsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR1.1 create + FR1.2 structured fields.
   *
   * Seeds the six PRD §14.1 default stages (decision B2). A job without
   * stages could never render a pipeline, so the two are created together in
   * one transaction rather than leaving a window where a job exists with none.
   */
  async create(user: AuthenticatedUser, dto: CreateJobDto): Promise<Job> {
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.job.create({
        data: {
          companyId: user.companyId,
          createdBy: user.id,
          title: dto.title,
          department: dto.department ?? null,
          location: dto.location ?? null,
          employmentType: dto.employmentType ?? null,
          experienceLevel: dto.experienceLevel ?? null,
          description: dto.description ?? null,
          requiredSkills: dto.requiredSkills ?? [],
          // status defaults to DRAFT; aiScoringEnabled defaults to false.
        },
      });

      await tx.pipelineStage.createMany({
        data: DEFAULT_PIPELINE_STAGES.map((name, index) => ({
          jobId: job.id,
          name,
          position: index + 1,
          isTerminal: TERMINAL_STAGES.has(name),
        })),
      });

      return job;
    });
  }

  /**
   * List jobs visible to this caller.
   *
   * PRD §24.2 gives the Hiring Manager "assigned jobs only", so their query is
   * narrowed through job_assignments (decision B1). JobAssignmentGuard covers
   * single-job routes; a list has no :id for it to inspect, so the restriction
   * must be applied here or an HM would see the whole tenant.
   */
  async list(
    user: AuthenticatedUser,
    query: ListJobsQueryDto,
  ): Promise<{ data: Job[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.JobWhereInput = {
      companyId: user.companyId, // BR-06 / R-09 — never unscoped.
      ...(query.status ? { status: query.status } : {}),
      ...(query.department ? { department: query.department } : {}),
      ...(user.role === UserRole.HIRING_MANAGER
        ? { assignments: { some: { userId: user.id } } }
        : {}),
    };

    // Fetch one extra row to learn whether another page exists without a
    // second COUNT query.
    const rows = await this.prisma.job.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    return { data, nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null };
  }

  /**
   * Read one job.
   *
   * JobAssignmentGuard has already proved tenancy and, for a Hiring Manager,
   * assignment. The companyId filter is repeated here deliberately: defence
   * in depth costs nothing, and a future caller that bypasses the guard must
   * not become a cross-tenant read (risk R-09).
   */
  async findOne(user: AuthenticatedUser, id: string): Promise<Job> {
    const job = await this.prisma.job.findFirst({
      where: { id, companyId: user.companyId },
    });
    if (!job) throw new NotFoundException();
    return job;
  }

  /** FR1.1 edit / publish / close. Returns before and after for the audit trail. */
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateJobDto,
  ): Promise<{ before: Job; after: Job }> {
    const before = await this.findOne(user, id);

    // Phase 1 RC-04 specifies a closed job is read-only.
    if (before.status === JobStatus.CLOSED) {
      throw new ConflictException('A closed job cannot be modified');
    }

    const data: Prisma.JobUpdateInput = {};

    if (dto.title !== undefined) data.title = dto.title;
    if (dto.department !== undefined) data.department = dto.department;
    if (dto.location !== undefined) data.location = dto.location;
    if (dto.employmentType !== undefined) data.employmentType = dto.employmentType;
    if (dto.experienceLevel !== undefined) data.experienceLevel = dto.experienceLevel;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.requiredSkills !== undefined) data.requiredSkills = dto.requiredSkills;

    if (dto.status !== undefined && dto.status !== before.status) {
      const allowed = ALLOWED_TRANSITIONS[before.status];
      if (!allowed.includes(dto.status)) {
        throw new ConflictException(`Cannot change status from ${before.status} to ${dto.status}`);
      }

      data.status = dto.status;

      if (dto.status === JobStatus.PUBLISHED) {
        // PRD §7 — the North Star metric measures from this timestamp, so it
        // is set once at first publication and never overwritten.
        data.publishedAt = before.publishedAt ?? new Date();
      }
      if (dto.status === JobStatus.CLOSED) {
        data.closedAt = new Date();
      }
    }

    const after = await this.prisma.job.update({ where: { id }, data });
    return { before, after };
  }

  /**
   * FR1.3 — duplicate an existing posting as a template.
   *
   * The copy is always a DRAFT, and `aiScoringEnabled` is deliberately NOT
   * copied. Carrying it over would let a Recruiter obtain an AI-enabled job
   * by duplicating one an Administrator had enabled, bypassing BR-04 without
   * ever calling the admin endpoint.
   *
   * Stages are copied so the template's pipeline configuration (decision B2)
   * survives the duplication.
   */
  async duplicate(user: AuthenticatedUser, id: string): Promise<Job> {
    const source = await this.prisma.job.findFirst({
      where: { id, companyId: user.companyId },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
    if (!source) throw new NotFoundException();

    return this.prisma.$transaction(async (tx) => {
      const copy = await tx.job.create({
        data: {
          companyId: source.companyId,
          createdBy: user.id, // the duplicator owns the copy, not the original author
          title: source.title,
          department: source.department,
          location: source.location,
          employmentType: source.employmentType,
          experienceLevel: source.experienceLevel,
          description: source.description,
          requiredSkills: source.requiredSkills as Prisma.InputJsonValue,
          status: JobStatus.DRAFT,
          aiScoringEnabled: false, // BR-04 — never inherited.
        },
      });

      const stages = source.stages.length
        ? source.stages.map((s) => ({
            jobId: copy.id,
            name: s.name,
            position: s.position,
            isTerminal: s.isTerminal,
          }))
        : DEFAULT_PIPELINE_STAGES.map((name, index) => ({
            jobId: copy.id,
            name,
            position: index + 1,
            isTerminal: TERMINAL_STAGES.has(name),
          }));

      await tx.pipelineStage.createMany({ data: stages });

      return copy;
    });
  }
}
