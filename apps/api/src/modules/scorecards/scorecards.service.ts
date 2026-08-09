import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Scorecard, UserRole, type Users } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import type { CreateScorecardDto } from './dto/create-scorecard.dto';
import { type ListReviewsQueryDto, ReviewStatus } from './dto/list-reviews.query.dto';

const DEFAULT_PAGE_SIZE = 25;

/** One row of the HM-01 review queue (Handoff Gap 1 response shape). */
export interface ReviewItem {
  applicationId: string;
  jobId: string;
  jobTitle: string;
  candidateName: string;
  requestedAt: Date;
  scorecardSubmitted: boolean;
}

/** A scorecard with the author identity RC-13 lists beside each entry. */
export type ScorecardWithAuthor = Scorecard & {
  author: Pick<Users, 'id' | 'email' | 'role'>;
};

const AUTHOR_FIELDS = { select: { id: true, email: true, role: true } } as const;

@Injectable()
export class ScorecardsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the application this caller is allowed to act on, or 404.
   *
   * Two scopes, applied together:
   *
   *   - TENANT — `applications` has no company_id of its own (PRD §17.2), so
   *     the scope is reached through the job. Enforced here rather than by a
   *     guard because JobAssignmentGuard keys off a job id in the route and
   *     these routes carry an application id.
   *
   *   - ASSIGNMENT — a Hiring Manager may only reach jobs they are assigned
   *     to (PRD §24.2 "assigned jobs only", decision B1). Without this an HM
   *     could score a candidate on a requisition they have no part in.
   *
   * Both refusals are 404, never 403: a 403 would confirm the application
   * exists somewhere the caller cannot see (BR-06, PRD §26).
   */
  private async findVisibleApplication(user: AuthenticatedUser, applicationId: string) {
    const application = await this.prisma.application.findFirst({
      where: {
        id: applicationId,
        job: {
          companyId: user.companyId,
          ...(user.role === UserRole.HIRING_MANAGER
            ? { assignments: { some: { userId: user.id } } }
            : {}),
        },
      },
      select: { id: true },
    });

    if (!application) throw new NotFoundException();
    return application;
  }

  /**
   * FR5.3 — submit structured feedback on one candidate.
   *
   * One scorecard per author per application (approved 9 Aug 2026). The
   * duplicate is caught from the DATABASE's unique violation rather than by
   * checking first: a read-then-write loses to two concurrent submissions and
   * would let a second row through.
   */
  async create(
    user: AuthenticatedUser,
    applicationId: string,
    dto: CreateScorecardDto,
  ): Promise<ScorecardWithAuthor> {
    await this.findVisibleApplication(user, applicationId);

    try {
      return await this.prisma.scorecard.create({
        data: {
          applicationId,
          authorId: user.id,
          rating: dto.rating,
          feedback: dto.feedback?.trim() || null,
        },
        include: { author: AUTHOR_FIELDS },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' // unique constraint violated
      ) {
        // Phase 1 HM-04 — "already submitted".
        throw new ConflictException('You have already submitted a scorecard for this candidate');
      }
      throw error;
    }
  }

  /**
   * GET /v1/me/reviews — the reviewer's own queue (Handoff Gap 1, HM-01).
   *
   * NO REVIEW-REQUEST ENTITY EXISTS, and none is invented. Nothing in the
   * system "requests" a review, so the queue is derived: every application on
   * a job the caller is assigned to is reviewable by them, and it is pending
   * until they personally submit a scorecard for it. `requestedAt` is
   * therefore the application's `appliedAt` — the moment the work arrived.
   *
   * SCOPE IS DERIVED, NEVER SUPPLIED. Gap 1 rule 3: results are scoped
   * server-side to `job_assignments` and "the client cannot widen this scope
   * by parameter" (NFR6). The scope below is built from the principal alone;
   * the DTO accepts nothing that could influence it.
   *
   * Applies to Administrators as well as Hiring Managers. Both roles may hold
   * assignments and both may submit scorecards, and the Handoff states the
   * scoping rule without exempting either — so an Administrator with no
   * assignments sees an empty queue, which Gap 1 calls "not an error".
   */
  async listReviews(
    user: AuthenticatedUser,
    query: ListReviewsQueryDto,
  ): Promise<{ data: ReviewItem[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const status = query.status ?? ReviewStatus.PENDING;

    const submittedByMe = { some: { authorId: user.id } };

    const rows = await this.prisma.application.findMany({
      where: {
        job: {
          companyId: user.companyId,
          assignments: { some: { userId: user.id } },
        },
        // "Pending" is per-reviewer: a colleague's scorecard does not clear
        // this caller's queue.
        scorecards:
          status === ReviewStatus.COMPLETED ? submittedByMe : { none: submittedByMe.some },
      },
      include: {
        job: { select: { id: true, title: true } },
        candidate: { select: { fullName: true } },
      },
      // Oldest work is not surfaced first anywhere else in the API; newest
      // first keeps the ordering consistent. `id` makes it total so the
      // cursor cannot skip or repeat a row.
      orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: page.map((application) => ({
        applicationId: application.id,
        jobId: application.job.id,
        jobTitle: application.job.title,
        candidateName: application.candidate.fullName,
        requestedAt: application.appliedAt,
        scorecardSubmitted: status === ReviewStatus.COMPLETED,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * FR5.3 — "Comments and scorecards are visible to the full hiring team."
   *
   * Every scorecard on the application, not just the caller's own: the point
   * of the requirement is that the team can see each other's assessments.
   * Oldest first, so the list reads as the review accumulated.
   */
  async listForApplication(
    user: AuthenticatedUser,
    applicationId: string,
  ): Promise<ScorecardWithAuthor[]> {
    await this.findVisibleApplication(user, applicationId);

    return this.prisma.scorecard.findMany({
      where: { applicationId },
      include: { author: AUTHOR_FIELDS },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
}
