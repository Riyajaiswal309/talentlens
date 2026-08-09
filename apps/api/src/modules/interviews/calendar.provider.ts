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
  interviewerEmails: string[];
}

/**
 * The calendar boundary (FR6.1, FR6.3).
 *
 * An abstract class used as the DI token, matching `ResumeScanner`,
 * `NotificationTransport` and `AiScoringPort` — the same seam this codebase
 * uses everywhere a real integration is specified but not yet available.
 *
 * FR6.1 names Google and Microsoft Outlook. Neither is built here: an OAuth
 * client registration, tenant-level connection storage and a consent flow are
 * required for both, and no document specifies any of them. What FR6.1 needs
 * from the rest of the system is a seam it can be bound into later, in one
 * place, without the scheduling logic changing.
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
}
