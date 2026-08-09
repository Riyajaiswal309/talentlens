import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InterviewStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CalendarProvider } from './calendar.provider';
import { SchedulingTokenService } from './scheduling-token.service';

/** Gap 7's `GET /v1/scheduling/:token` 200 body. */
export interface SchedulingOffer {
  jobTitle: string;
  interviewerNames: string[];
  slots: { slotId: string; startsAt: string; endsAt: string; timezone: string }[];
  expiresAt: string;
}

/** Gap 7's `POST /v1/scheduling/:token/confirm` 200 body. */
export interface SchedulingConfirmation {
  interviewId: string;
  scheduledAt: string;
  calendarEventId: string | null;
}

/**
 * The candidate's half of FR6.2 (Handoff Gap 7).
 *
 * Both routes are reached with a scheduling token and no session. Gap 7 rule
 * 4 fixes the blast radius: "the token grants access to **one** interview
 * only; it confers no other read access [BR-06]". Every query below is keyed
 * by the interview id inside the token, and nothing widens from there — no
 * candidate id, no company id, no listing.
 *
 * The status codes are Gap 7's, not this file's invention. The distinction
 * between 410 and 409 is the one worth stating: 410 is a link that was already
 * spent or withdrawn before the request arrived, 409 is losing a race during
 * it. A candidate who clicks an old email gets the former; a candidate who
 * double-submits gets the latter.
 */
@Injectable()
export class SchedulingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: SchedulingTokenService,
    private readonly calendar: CalendarProvider,
  ) {}

  /**
   * Resolve a token to its interview.
   *
   * `401` for a token that does not verify — malformed, wrong signature or
   * expired, all indistinguishable in the response by design. `404` for a
   * token that verifies but names an interview that no longer exists, which
   * is Gap 7's "token unknown".
   */
  private async resolve(token: string) {
    const claims = this.tokens.verify(token);
    if (!claims)
      throw new UnauthorizedException('This scheduling link is not valid or has expired');

    const interview = await this.prisma.interview.findUnique({
      where: { id: claims.interviewId },
      include: {
        slots: { orderBy: { startsAt: 'asc' } },
        interviewers: { include: { user: { select: { email: true } } } },
        application: {
          select: {
            candidate: { select: { fullName: true } },
            job: { select: { title: true } },
          },
        },
      },
    });

    if (!interview) throw new NotFoundException();
    return { interview, expiresAt: new Date(claims.exp * 1000) };
  }

  /** GET /v1/scheduling/:token — what the candidate is being offered. */
  async getOffer(token: string): Promise<SchedulingOffer> {
    const { interview, expiresAt } = await this.resolve(token);

    if (interview.status !== InterviewStatus.PENDING_SELECTION) {
      throw new GoneException('This interview has already been scheduled or was cancelled');
    }

    return {
      jobTitle: interview.application.job.title,
      /*
       * Gap 7 says `interviewerNames`. `users` has no name column — PRD §17.2
       * models it with email and role only — so the local part of the address
       * is used rather than adding a column for a display string. It is the
       * closest thing to a name the schema holds, and CA-06 needs to show the
       * candidate who they are meeting, not to identify them precisely.
       */
      interviewerNames: interview.interviewers.map((i) => i.user.email.split('@')[0] ?? ''),
      slots: interview.slots.map((slot) => ({
        slotId: slot.id,
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
        timezone: slot.timezone,
      })),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * POST /v1/scheduling/:token/confirm — the candidate takes a slot.
   *
   * The order of the checks is the security-relevant part. Gap 7 rule 2 —
   * "`slotId` must belong to the set offered by *this* token" — is settled
   * before anything is written, so a candidate cannot book a window that was
   * never offered to them by naming another interview's slot id.
   */
  async confirm(token: string, slotId: string): Promise<SchedulingConfirmation> {
    const { interview } = await this.resolve(token);

    // Gap 7 `410` — a spent or withdrawn link. Checked before the race so a
    // stale click reads as stale rather than as a lost race.
    if (interview.status !== InterviewStatus.PENDING_SELECTION) {
      throw new GoneException('This interview has already been scheduled or was cancelled');
    }

    const slot = interview.slots.find((candidate) => candidate.id === slotId);
    if (!slot) {
      throw new BadRequestException('That time is not one of the slots offered for this interview');
    }

    /*
     * FR6.3 / Gap 7 `503`. Asked before the write so a provider outage does
     * not leave a booking recorded with no invite; the client falls back to
     * manual scheduling and the recruiter enters the time instead.
     *
     * The default ManualCalendarProvider reports available and creates no
     * event, so a deployment with no calendar integration takes the ordinary
     * success path — which is what FR6.3 requires of it.
     */
    if (!this.calendar.isAvailable()) {
      throw new ServiceUnavailableException(
        'The calendar service is unavailable. Your recruiter will arrange a time with you directly.',
      );
    }

    /*
     * Gap 7 rule 3: "Slot must still be unclaimed at commit time
     * (transactional check, not read-then-write)."
     *
     * `updateMany` with the status in the WHERE clause is the whole check —
     * Postgres serialises the two writers and the loser matches zero rows.
     * A findFirst-then-update would let both readers see PENDING_SELECTION
     * and both write, and the second would silently overwrite the first
     * candidate's choice.
     */
    const claimed = await this.prisma.interview.updateMany({
      where: { id: interview.id, status: InterviewStatus.PENDING_SELECTION },
      data: {
        status: InterviewStatus.SCHEDULED,
        scheduledAt: slot.startsAt,
        timezone: slot.timezone,
        selectedSlotId: slot.id,
      },
    });

    if (claimed.count === 0) {
      throw new ConflictException('That time was just taken. Please choose another.');
    }

    /*
     * The event is created after the slot is safely claimed. If it fails the
     * interview still stands with no calendar_event_id, which FR6.3 treats as
     * a complete booking — the alternative, rolling back a confirmed time
     * because an invite could not be sent, is the workflow failure FR6.3
     * exists to prevent.
     */
    const event = await this.calendar
      .createEvent({
        jobTitle: interview.application.job.title,
        candidateName: interview.application.candidate.fullName,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        timezone: slot.timezone,
        interviewerEmails: interview.interviewers.map((i) => i.user.email),
      })
      .catch(() => null);

    if (event) {
      await this.prisma.interview.update({
        where: { id: interview.id },
        data: { calendarEventId: event.eventId },
      });
    }

    return {
      interviewId: interview.id,
      scheduledAt: slot.startsAt.toISOString(),
      calendarEventId: event?.eventId ?? null,
    };
  }
}
