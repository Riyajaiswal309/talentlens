import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InterviewStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { NotificationsService } from '../notifications/notifications.service';
import { CalendarProvider } from './calendar.provider';
import type { CreateInterviewDto } from './dto/create-interview.dto';
import { SchedulingTokenService } from './scheduling-token.service';

/** An interview with everything RC-11 and CA-05 render beside it. */
const INTERVIEW_VIEW = {
  slots: { orderBy: { startsAt: 'asc' } },
  interviewers: { include: { user: { select: { id: true, email: true } } } },
  application: {
    select: {
      id: true,
      candidate: { select: { fullName: true, email: true } },
      job: { select: { id: true, title: true, companyId: true } },
    },
  },
} as const;

export type InterviewView = Prisma.InterviewGetPayload<{ include: typeof INTERVIEW_VIEW }>;

/** What `create` hands back: the interview plus the link, when one was issued. */
export interface CreatedInterview {
  interview: InterviewView;
  /** FR6.2 only. Null on the manual path — nothing for a candidate to choose. */
  schedulingToken: string | null;
  expiresAt: Date | null;
}

@Injectable()
export class InterviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarProvider,
    private readonly tokens: SchedulingTokenService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Resolve an application this caller may act on, or 404.
   *
   * Same two scopes as `ScorecardsService.findVisibleApplication`, and for the
   * same reasons: `applications` has no company_id of its own (PRD §17.2), so
   * tenancy is reached through the job, and a guard cannot do it because
   * JobAssignmentGuard keys off a job id that these routes do not carry.
   *
   * Refusal is 404, never 403 — a 403 would confirm the application exists in
   * a tenant the caller cannot see (BR-06, PRD §26).
   *
   * Hiring Managers are scoped to their assignments here even though they may
   * not create interviews (§24.2 gives scheduling to Recruiter and Admin), so
   * that the read path added for RC-06/CA-05 obeys the same rule.
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
      select: {
        id: true,
        candidate: { select: { fullName: true, email: true } },
        job: { select: { id: true, title: true } },
      },
    });

    if (!application) throw new NotFoundException();
    return application;
  }

  /**
   * POST /v1/interviews — FR6.1–FR6.3, Phase 1 RC-11 and flow 8.
   *
   * Which of the two paths runs is decided by the body: `slots` means
   * self-service (FR6.2), `scheduledAt` means manual (FR6.3). Sending both or
   * neither is a 400 — the endpoint would otherwise have to guess whether the
   * candidate is being asked to choose, and getting that wrong either strands
   * an interview waiting for a selection nobody requested or books a time the
   * candidate never agreed to.
   */
  async create(user: AuthenticatedUser, dto: CreateInterviewDto) {
    const application = await this.findVisibleApplication(user, dto.applicationId);

    const selfService = dto.slots !== undefined;
    const manual = dto.scheduledAt !== undefined;

    if (selfService === manual) {
      throw new BadRequestException(
        selfService
          ? 'Send either slots (candidate self-schedules, FR6.2) or scheduledAt (manual booking, FR6.3), not both'
          : 'Send either slots (candidate self-schedules, FR6.2) or scheduledAt (manual booking, FR6.3)',
      );
    }

    if (manual && !dto.timezone) {
      throw new BadRequestException('timezone is required when booking a time directly');
    }

    const interviewers = await this.resolvePanel(user, dto.interviewerIds ?? []);

    if (selfService) {
      return this.createSelfService(user, application, dto, interviewers);
    }
    return this.createManual(user, application, dto, interviewers);
  }

  /**
   * Interviewers must be colleagues.
   *
   * Scoped to the caller's own company, so a panel cannot be assembled from
   * another tenant's staff. An id that does not resolve is a 400 naming the
   * count rather than which one — the caller supplied the list, so it is a
   * request error, but confirming *which* id is foreign would answer "does
   * this user exist in some other company?" for free (BR-06's principle).
   */
  private async resolvePanel(user: AuthenticatedUser, ids: string[]) {
    if (ids.length === 0) return [];

    const users = await this.prisma.users.findMany({
      where: { id: { in: ids }, companyId: user.companyId },
      select: { id: true, email: true },
    });

    if (users.length !== ids.length) {
      throw new BadRequestException('One or more interviewerIds are not users of this company');
    }
    return users;
  }

  /** FR6.2 — offer slots and issue the self-service link. */
  private async createSelfService(
    user: AuthenticatedUser,
    application: {
      id: string;
      candidate: { fullName: string; email: string };
      job: { title: string };
    },
    dto: CreateInterviewDto,
    interviewers: { id: string; email: string }[],
  ) {
    const slots = (dto.slots ?? []).map((slot) => ({
      startsAt: new Date(slot.startsAt),
      endsAt: new Date(slot.endsAt),
      timezone: slot.timezone,
    }));

    for (const slot of slots) {
      if (slot.endsAt <= slot.startsAt) {
        throw new BadRequestException('each slot must end after it starts');
      }
    }

    const interview = await this.prisma.interview.create({
      data: {
        applicationId: application.id,
        status: InterviewStatus.PENDING_SELECTION,
        createdBy: user.id,
        slots: { create: slots },
        interviewers: { create: interviewers.map((i) => ({ userId: i.id })) },
      },
      include: INTERVIEW_VIEW,
    });

    /*
     * The link expires when the last slot ends. Derived rather than chosen:
     * no document states a TTL, and past that moment every choice the link
     * could express is already in the past, so a longer life would only widen
     * the window in which a leaked link is worth something.
     */
    const expiresAt = slots.reduce(
      (latest, slot) => (slot.endsAt > latest ? slot.endsAt : latest),
      slots[0]!.endsAt,
    );
    const token = this.tokens.sign(interview.id, expiresAt);

    // FR6.2 — "Candidates receive a self-service scheduling link." Never
    // blocks the booking: the recruiter's action is complete and the link can
    // be re-sent, so a transport fault must not undo it (same rule as FR2.3).
    await this.notifications
      .interviewSchedulingLink({
        email: application.candidate.email,
        candidateName: application.candidate.fullName,
        jobTitle: application.job.title,
        token,
        expiresAt,
      })
      .catch(() => undefined);

    return { interview, schedulingToken: token, expiresAt };
  }

  /**
   * FR6.3 — the recruiter books a time directly.
   *
   * Reached both when no provider is configured and when Phase 1 flow 8's
   * error row applies ("provider unavailable → recruiter enters date/time
   * directly and the flow completes without calendar integration"). The
   * calendar is attempted and its absence tolerated: `createEvent` returning
   * null leaves `calendar_event_id` NULL, which is exactly what a manually
   * arranged interview looks like.
   */
  private async createManual(
    user: AuthenticatedUser,
    application: {
      id: string;
      candidate: { fullName: string; email: string };
      job: { title: string };
    },
    dto: CreateInterviewDto,
    interviewers: { id: string; email: string }[],
  ) {
    const scheduledAt = new Date(dto.scheduledAt!);

    const event = this.calendar.isAvailable()
      ? await this.calendar
          .createEvent({
            jobTitle: application.job.title,
            candidateName: application.candidate.fullName,
            startsAt: scheduledAt,
            // No duration is specified anywhere, so the booking is recorded as
            // an instant and the window is left to the provider's default.
            endsAt: scheduledAt,
            timezone: dto.timezone!,
            interviewerEmails: interviewers.map((i) => i.email),
            // D39 — the panel by user_id, so the router can find whose
            // calendar hosts the event. Emails address the invitation only.
            interviewerUserIds: interviewers.map((i) => i.id),
          })
          // FR6.3 — a provider that fails mid-call must not fail the booking.
          .catch(() => null)
      : null;

    const interview = await this.prisma.interview.create({
      data: {
        applicationId: application.id,
        status: InterviewStatus.SCHEDULED,
        scheduledAt,
        timezone: dto.timezone,
        calendarEventId: event?.eventId ?? null,
        createdBy: user.id,
        interviewers: { create: interviewers.map((i) => ({ userId: i.id })) },
      },
      include: INTERVIEW_VIEW,
    });

    return { interview, schedulingToken: null, expiresAt: null };
  }

  /**
   * GET /v1/applications/:id/interviews.
   *
   * Not in PRD §23.2 or Handoff §B. Phase 1 flow 8's success criterion is
   * "Interview appears on RC-11 and CA-05" and line 1240 binds `interviews`
   * to both screens, neither of which is reachable without a read. The path
   * mirrors the documented siblings `…/scorecards` and `…/comments` exactly,
   * which is the shape this project has twice used for the same situation.
   */
  async listForApplication(user: AuthenticatedUser, applicationId: string) {
    await this.findVisibleApplication(user, applicationId);

    return this.prisma.interview.findMany({
      where: { applicationId },
      include: INTERVIEW_VIEW,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * POST /v1/interviews/:id/cancel — withdraw an interview.
   *
   * TENANCY IS REACHED THROUGH THE JOB, as everywhere else that touches an
   * application: `interviews` carries no company_id, so the lookup filters on
   * `application.job.companyId`. A `JobScoped` guard cannot help — this route
   * carries an interview id, not a job id — so the scope lives in the query.
   * A foreign or absent id is 404, never 403 (BR-06).
   *
   * CANCELLING AN ALREADY-CANCELLED INTERVIEW IS A 409, not a silent success.
   * The caller believes they are withdrawing something live; telling them it
   * was already withdrawn is more useful than a no-op that reads as an action.
   *
   * THE STATUS CHANGE IS THE WHOLE MECHANISM THAT KILLS THE LINK. Both
   * scheduling routes refuse anything that is not `PENDING_SELECTION` with a
   * 410, so a cancelled interview's outstanding link stops working the moment
   * this commits — there is no second revocation step to forget.
   *
   * THE EXTERNAL CALENDAR EVENT IS NOT DELETED, and this is stated rather than
   * hidden. `CalendarProvider` exposes `createEvent` and `getAvailability` and
   * nothing that removes an event; inventing a delete path here would mean
   * writing provider code that cannot be exercised without live credentials.
   * `calendar_event_id` is therefore left intact — it is a true record of what
   * was created — and the caller is told the invitation must be withdrawn by
   * hand. Clearing the column would be worse: it would erase the only evidence
   * that an event exists out there.
   */
  async cancel(user: AuthenticatedUser, interviewId: string): Promise<InterviewView> {
    const interview = await this.prisma.interview.findFirst({
      where: { id: interviewId, application: { job: { companyId: user.companyId } } },
      include: INTERVIEW_VIEW,
    });

    if (!interview) throw new NotFoundException();

    if (interview.status === InterviewStatus.CANCELLED) {
      throw new ConflictException('This interview has already been cancelled');
    }

    /*
     * Guarded by status in the WHERE clause, so two concurrent cancellations
     * cannot both believe they won. The loser matches zero rows and is told the
     * interview was already cancelled — the same answer it would have received
     * a moment later.
     */
    const claimed = await this.prisma.interview.updateMany({
      where: { id: interview.id, status: { not: InterviewStatus.CANCELLED } },
      data: { status: InterviewStatus.CANCELLED },
    });

    if (claimed.count === 0) {
      throw new ConflictException('This interview has already been cancelled');
    }

    return this.prisma.interview.findFirstOrThrow({
      where: { id: interview.id },
      include: INTERVIEW_VIEW,
    });
  }
}
