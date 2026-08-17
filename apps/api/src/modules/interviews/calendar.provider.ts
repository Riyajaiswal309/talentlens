import { Injectable, Logger } from '@nestjs/common';

/** A calendar event the provider created, or the fact that it could not. */
export interface CalendarEvent {
  /** Provider-side id, stored on `interviews.calendar_event_id`. */
  eventId: string;
}

export interface CalendarBooking {
  jobTitle: string;
  candidateName: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  /**
   * Attendee addresses (D41 — interviewers only; the candidate is never
   * invited). These address the invitation; they are NOT an identity claim.
   */
  interviewerEmails: string[];
  /**
   * The same panel by `user_id` (D39).
   *
   * Needed to find whose calendar hosts the event: a connection belongs to a
   * user (D34), and `users.email` is only tenant-unique so it cannot be used
   * to look one up.
   */
  interviewerUserIds: string[];
}

/** A window of time an interviewer is already committed. */
export interface BusyBlock {
  startsAt: Date;
  endsAt: Date;
}

/**
 * One interviewer's committed time within the requested window.
 *
 * BUSY, NOT FREE. A provider can state when someone is unavailable without
 * disclosing what they are doing; deriving free time is the caller's job and
 * needs no event titles, attendees or locations. This is the narrowest shape
 * that satisfies RC-11's availability grid, and it keeps the seam from
 * carrying calendar contents it has no reason to see.
 */
export interface InterviewerAvailability {
  email: string;
  busy: BusyBlock[];
}

/**
 * The calendar boundary (FR6.1, FR6.3).
 *
 * An abstract class used as the DI token, matching `ResumeScanner`,
 * `NotificationTransport` and `AiScoringPort` — the same seam this codebase
 * uses everywhere a real integration is specified but not yet available.
 *
 * FR6.1 names Google and Microsoft Outlook, and D35 puts both in v1 scope.
 * NEITHER APPEARS IN THIS FILE, deliberately: the adapters, the consent flow
 * and the connection storage all live in `CalendarModule`, which binds this
 * token to `ConnectedCalendarProvider`. Scheduling code sees only the three
 * methods below, so it reads identically whichever provider an interviewer
 * connected — the one job D35 gives this seam.
 *
 * FR6.3 is the reason `isAvailable` exists as a separate question from
 * `createEvent`: "if the calendar provider is unavailable, the system degrades
 * gracefully to manual scheduling rather than failing the workflow". Callers
 * ask first and take the manual path on a no, instead of discovering the
 * outage through an exception halfway through a booking.
 */
export abstract class CalendarProvider {
  /** FR6.3 — false puts the caller on the manual path before it commits. */
  abstract isAvailable(): boolean;

  /**
   * Create the event, or return null if the provider declined.
   *
   * Null is not an error. An interview with no calendar event is a complete,
   * valid interview under FR6.3; only the convenience of a provider-side
   * invite is missing.
   */
  abstract createEvent(booking: CalendarBooking): Promise<CalendarEvent | null>;

  /**
   * FR6.1 — "Calendar integration surfaces interviewer availability."
   *
   * THIS METHOD IS THE SEAM FR6.1 ACTUALLY ASKS FOR, and it did not exist
   * before. `isAvailable()` above answers "is the provider reachable" (FR6.3);
   * despite the similar name it says nothing about when a person is free.
   * Event creation is Phase 1 flow 8 step 5; availability is step 2, and the
   * two are different halves of §11.6.
   *
   * `null` means NO PROVIDER IS CONNECTED — not "everyone is free" and not
   * "nobody is free". The distinction matters: RC-11 renders an availability
   * grid, and an empty array would draw a grid asserting the interviewers have
   * no commitments, which is a claim nothing has verified. Null sends the
   * caller to the manual path FR6.3 already defines, alongside the empty state
   * flow 8 specifies ("No availability in range → widen-range prompt").
   *
   * IDENTITY IN IS `user_id`, IDENTITY OUT IS THE PROVIDER ACCOUNT. D42 fixes
   * the endpoint's input as user ids and D39 makes `user_id` the persisted
   * identity, while the returned `email` is the `account_identifier` the
   * provider authorised (D37) — the only address it knows the person by.
   *
   * Served by `GET /v1/interviews/availability` (D42, B8).
   */
  abstract getAvailability(
    interviewerUserIds: string[],
    window: { from: Date; to: Date },
  ): Promise<InterviewerAvailability[] | null>;
}

/**
 * The default binding: manual scheduling, exactly as FR6.3 describes it.
 *
 * Reports itself AVAILABLE and creates no event. That combination is
 * deliberate and is the difference between a degraded system and a broken one.
 * FR6.3 requires the workflow to complete without the provider, so the manual
 * mode must let a booking through — reporting `false` here would make every
 * self-service confirmation return Gap 7's `503` and no interview could ever
 * be scheduled on a default deployment.
 *
 * `createEvent` returning null leaves `calendar_event_id` NULL, which is how
 * the database records "this interview was arranged by hand".
 *
 * `getAvailability` returns null for the same reason: with no provider there
 * is no free/busy data to report, and inventing an empty schedule would tell
 * a recruiter the interviewer is free all week.
 */
@Injectable()
export class ManualCalendarProvider extends CalendarProvider {
  private readonly logger = new Logger(ManualCalendarProvider.name);

  isAvailable(): boolean {
    return true;
  }

  async createEvent(booking: CalendarBooking): Promise<CalendarEvent | null> {
    this.logger.log(
      `manual scheduling (FR6.3): no calendar provider configured; ` +
        `${booking.jobTitle} with ${booking.candidateName} at ` +
        `${booking.startsAt.toISOString()} (${booking.timezone})`,
    );
    return null;
  }

  /**
   * FR6.1 with no provider connected: there is nothing to report.
   *
   * Null rather than `[]`. An empty array would render RC-11's grid as though
   * every interviewer were free for the whole window, which is a statement
   * about their diaries that this deployment cannot make.
   */
  async getAvailability(
    // Both parameters are accepted and ignored. Declaring the full signature
    // rather than dropping it keeps the concrete class callable exactly like
    // the abstract token — an override with fewer parameters compiles, but
    // then code holding a ManualCalendarProvider could not pass the arguments
    // the contract documents.
    _interviewerUserIds: string[],
    _window: { from: Date; to: Date },
  ): Promise<InterviewerAvailability[] | null> {
    return null;
  }
}
