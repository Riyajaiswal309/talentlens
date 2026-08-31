import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { JOB_SCOPED_KEY, type JobScopedMetadata } from '../decorators/resource-access.decorator';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../types/authenticated-request';

/**
 * PRD §24.2 — "View AI rankings + rationale ✓ (assigned jobs only)" for the
 * Hiring Manager role. Enforced through the job_assignments table (decision
 * B1, approved 8 Aug 2026).
 *
 * Also enforces tenancy on the job itself. TenantGuard proves the caller HAS
 * a tenant; this guard proves the JOB BELONGS TO IT. Without the second
 * check, a recruiter could read another company's job by guessing its id —
 * exactly the cross-tenant leak risk R-09 describes.
 *
 * Refusals are 404, consistent with BR-06: a 403 would confirm that a job id
 * exists in some other tenant.
 */
/** Canonical RFC 4122 spelling — the only form this system mints. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class JobAssignmentGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.getAllAndOverride<JobScopedMetadata | undefined>(
      JOB_SCOPED_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!metadata) return true;

    const request = context.switchToHttp().getRequest<RequestContext>();
    const user = request.user;

    // Public route — no principal to scope. Public job endpoints expose only
    // published jobs and are handled by their own service logic.
    if (!user) return true;

    /*
     * A MALFORMED ID IS A 404, NOT A CRASH.
     *
     * This guard runs BEFORE `ParseUUIDPipe` — guards precede pipes in Nest —
     * so a segment like `/v1/jobs/not-a-uuid` used to reach Postgres as a `uuid`
     * comparison and come back as a 500. Every `@JobScoped()` route inherited
     * that: it is a property of the guard, not of any one controller.
     *
     * The shape is checked here rather than left to the pipe because the pipe
     * never gets a chance to run. 404 rather than 400 keeps BR-06 intact: a
     * malformed id, an id that does not exist, and another tenant's id are all
     * indistinguishable, so nothing about the id space can be probed.
     *
     * Canonical 8-4-4-4-12 only. Postgres would also accept exotic spellings
     * (unhyphenated, brace-wrapped), but every id this system mints is
     * canonical and `ParseUUIDPipe` would refuse the rest at the handler
     * anyway — so treating them as "not found" is the safe direction.
     */
    const jobId = readParam(request, metadata.param ?? 'id');
    if (!jobId || !CANONICAL_UUID.test(jobId)) throw new NotFoundException();

    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, companyId: true },
    });

    // Absent, or belonging to another tenant — indistinguishable by design.
    if (!job || job.companyId !== user.companyId) throw new NotFoundException();

    // ADMIN and RECRUITER see every job in their own tenant (§24.2).
    if (user.role !== UserRole.HIRING_MANAGER) return true;

    const assignment = await this.prisma.jobAssignment.findUnique({
      where: { jobId_userId: { jobId, userId: user.id } },
      select: { id: true },
    });

    if (!assignment) throw new NotFoundException();

    return true;
  }
}

function readParam(request: RequestContext, name: string): string | undefined {
  const value = request.params?.[name];
  return typeof value === 'string' ? value : undefined;
}
