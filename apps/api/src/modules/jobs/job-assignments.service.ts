import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { ASSIGNABLE_ROLES, type JobAssignmentResponse } from './dto/job-assignment.dto';

/**
 * FR1 / §24.2 — who may work a requisition (amendment A1, decision B1).
 *
 * THE WRITE PATH THAT WAS MISSING. `job_assignments` has been read by seven
 * call sites since Phase 2 — `JobAssignmentGuard`, job listing, tags,
 * interviews, comments, scorecards and `/v1/me/reviews` — but nothing outside
 * `prisma/seed.ts` ever wrote a row. The permission was enforceable and not
 * grantable, which meant a Hiring Manager could only be given access by
 * editing the database by hand.
 *
 * TENANCY IS CHECKED TWICE, ON PURPOSE. `@JobScoped()` already proves the job
 * belongs to the caller's company before the handler runs; every query here
 * still filters on `companyId`, for the reason `JobsService.findOne` states —
 * defence in depth costs nothing, and a future caller that bypasses the guard
 * must not become a cross-tenant write (risk R-09).
 */
@Injectable()
export class JobAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolve a job inside the caller's tenant, or refuse indistinguishably. */
  private async findJob(user: AuthenticatedUser, jobId: string) {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, companyId: user.companyId },
      select: { id: true, companyId: true },
    });
    // 404 rather than 403 (BR-06): a 403 would confirm the id exists elsewhere.
    if (!job) throw new NotFoundException();
    return job;
  }

  async list(user: AuthenticatedUser, jobId: string): Promise<JobAssignmentResponse[]> {
    await this.findJob(user, jobId);

    const rows = await this.prisma.jobAssignment.findMany({
      where: { jobId },
      include: { user: { select: { id: true, email: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map(toResponse);
  }

  /**
   * Assign a colleague to a job.
   *
   * THE TARGET IS VALIDATED IN TWO STEPS, and the order matters. Membership of
   * the caller's tenant is settled first, with ONE message covering both "no
   * such user" and "another tenant's user" — the same wording `resolvePanel`
   * uses for interviewers, so the response cannot be used to probe which user
   * ids exist elsewhere (BR-06). Only once the target is known to be a
   * colleague does the role check speak plainly, because by then it discloses
   * nothing the caller could not already read from `GET /v1/interviewers`.
   *
   * A CLOSED JOB IS STILL ASSIGNABLE. `JobsService.update` refuses to modify a
   * closed requisition, but an assignment is not an edit to the job — reviewers
   * still need to read a closed role's candidates, and their scorecards and
   * comments outlive the requisition.
   */
  async add(
    user: AuthenticatedUser,
    jobId: string,
    userId: string,
  ): Promise<JobAssignmentResponse> {
    await this.findJob(user, jobId);

    const target = await this.prisma.users.findFirst({
      where: { id: userId, companyId: user.companyId },
      select: { id: true, email: true, role: true },
    });
    if (!target) {
      throw new BadRequestException('That user is not a member of this company');
    }

    if (!ASSIGNABLE_ROLES.includes(target.role)) {
      throw new BadRequestException(
        target.role === UserRole.RECRUITER
          ? 'Recruiters already reach every job in the company and cannot be assigned to one'
          : 'Only hiring managers and administrators can be assigned to a job',
      );
    }

    try {
      const created = await this.prisma.jobAssignment.create({
        data: { jobId, userId: target.id },
        include: { user: { select: { id: true, email: true, role: true } } },
      });
      return toResponse(created);
    } catch (error) {
      /*
       * P2002 from `@@unique([jobId, userId])`. Reported rather than silently
       * succeeding: the caller asked for something the record already says, and
       * a no-op dressed as a fresh assignment would hide that from them.
       */
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('That user is already assigned to this job');
      }
      throw error;
    }
  }

  /**
   * Remove an assignment.
   *
   * NOT IDEMPOTENT-204. A missing assignment answers 404, matching how a tag is
   * removed: silently succeeding would let a stale screen report that it had
   * revoked access it never held, and revoking access is exactly the operation
   * where the caller must be told the truth.
   */
  async remove(
    user: AuthenticatedUser,
    jobId: string,
    userId: string,
  ): Promise<JobAssignmentResponse> {
    await this.findJob(user, jobId);

    const existing = await this.prisma.jobAssignment.findUnique({
      where: { jobId_userId: { jobId, userId } },
      include: { user: { select: { id: true, email: true, role: true } } },
    });
    if (!existing) throw new NotFoundException();

    await this.prisma.jobAssignment.delete({ where: { id: existing.id } });

    // Returned so the controller can record WHAT stopped applying.
    return toResponse(existing);
  }
}

function toResponse(row: {
  id: string;
  userId: string;
  createdAt: Date;
  user: { email: string; role: UserRole };
}): JobAssignmentResponse {
  return {
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    role: row.user.role,
    createdAt: row.createdAt.toISOString(),
  };
}
