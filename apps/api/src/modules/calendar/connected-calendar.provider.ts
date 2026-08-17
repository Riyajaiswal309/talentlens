import { Injectable, Logger } from '@nestjs/common';
import { CalendarProvider as Provider } from '@prisma/client';
import {
  CalendarProvider,
  type CalendarBooking,
  type CalendarEvent,
  type InterviewerAvailability,
} from '../interviews/calendar.provider';
import { CalendarConnectionsService } from './calendar-connections.service';
import { CalendarProviderRegistry } from './calendar-provider.registry';
import { ProviderCredentialError, ProviderUnavailableError } from './providers/provider-adapter';

/**
 * The real binding for `CalendarProvider`, routing per interviewer (D34, D35).
 *
 * WHY A ROUTER. A connection belongs to a person, not to the deployment, so
 * "read this interviewer's calendar" means "find their connection, pick the
 * adapter for its provider, use their credential". One user may be on Google
 * and their colleague on Microsoft; the scheduling API cannot tell, which is
 * exactly what D35 requires.
 *
 * THREE STATES, KEPT APART — this is the class's real job:
 *
 *   no provider configured   isAvailable() true, createEvent null,
 *                            getAvailability null. Identical to
 *                            ManualCalendarProvider, so FR6.3 and every
 *                            existing scheduling test behave unchanged.
 *   configured and healthy   real calls.
 *   configured but failing   ProviderUnavailableError, surfaced as Gap 7's
 *                            503 by the caller.
 *
 * "Nobody has connected a calendar" is NONE of those three: it is reported as
 * `notConnected`, never as an outage (F).
 */
@Injectable()
export class ConnectedCalendarProvider extends CalendarProvider {
  private readonly logger = new Logger(ConnectedCalendarProvider.name);

  constructor(
    private readonly connections: CalendarConnectionsService,
    private readonly registry: CalendarProviderRegistry,
  ) {
    super();
  }

  /**
   * FR6.3 — is the provider layer usable at all?
   *
   * True when nothing is configured, because that is manual-scheduling mode
   * and D15 requires the workflow to complete: reporting false would make
   * every self-service confirmation return 503 on a deployment that simply
   * has no calendar integration.
   */
  isAvailable(): boolean {
    return true;
  }

  /**
   * FR6.1 — busy blocks for the given TalentLens users.
   *
   * Identity in is `user_id` (D39, D42); identity out is the provider account
   * (D37), which is what the caller displays and the only address the provider
   * knows them by.
   *
   * Returns null only when NO provider is configured — "we cannot answer this
   * at all". A configured deployment always returns an array, even an empty
   * one, and reports individual unconnected users through the caller's
   * `notConnected` list rather than by omission.
   */
  async getAvailability(
    interviewerUserIds: string[],
    window: { from: Date; to: Date },
  ): Promise<InterviewerAvailability[] | null> {
    if (!this.registry.anyConfigured()) return null;
    if (interviewerUserIds.length === 0) return [];

    const live = await this.connections.listConnectedFor(interviewerUserIds);
    const results: InterviewerAvailability[] = [];

    /*
     * Grouped by provider so each adapter is asked once for all of its own
     * accounts — Google's freebusy.query and Graph's getSchedule both take a
     * list, and a per-user call would multiply latency by the panel size.
     *
     * The querying credential is one connected user's; both providers permit
     * reading colleagues' free/busy under it, which is why the group needs a
     * single caller rather than each user's own token.
     */
    for (const provider of Object.values(Provider)) {
      const group = live.filter((c) => c.provider === provider);
      if (group.length === 0) continue;

      const adapter = this.registry.get(provider);
      if (!adapter?.isConfigured()) {
        // A connection exists for a provider this deployment no longer
        // configures. Not an outage and not the user's fault — they are simply
        // unanswerable, so they fall through to `notConnected`.
        continue;
      }

      const caller = group[0]!;
      const token = await this.connections.resolveRefreshToken(caller.userId, provider);
      if (!token) continue;

      try {
        const grant = await adapter.accessToken(token);
        const busy = await adapter.freeBusy(
          grant.accessToken,
          group.map((c) => c.accountIdentifier),
          window,
        );

        for (const connection of group) {
          results.push({
            email: connection.accountIdentifier,
            busy: busy.get(connection.accountIdentifier) ?? [],
          });
        }
      } catch (error) {
        if (error instanceof ProviderCredentialError) {
          // D36 — permanent. Disconnect rather than retry, and treat the group
          // as unanswerable for this request.
          await this.connections.markDisconnectedFor(caller.userId, provider);
          this.logger.warn(`${provider}: credential rejected; connection disconnected`);
          continue;
        }
        // Transient: the caller turns this into Gap 7's 503.
        throw error instanceof ProviderUnavailableError
          ? error
          : new ProviderUnavailableError(provider, error);
      }
    }

    return results;
  }

  /**
   * Create the interview event on an interviewer's calendar.
   *
   * THE ORGANISER IS THE FIRST CONNECTED INTERVIEWER. The event has to live on
   * somebody's calendar and the candidate is never an attendee (D41), so it
   * belongs to the panel. No document names an organiser, and picking the
   * first connected interviewer keeps the rule stated rather than hidden.
   *
   * Null — not an exception — when nobody on the panel has a calendar or no
   * provider is configured. FR6.3 makes an interview with no calendar event a
   * complete interview.
   */
  async createEvent(booking: CalendarBooking): Promise<CalendarEvent | null> {
    if (!this.registry.anyConfigured()) return null;
    if (booking.interviewerUserIds.length === 0) return null;

    const live = await this.connections.listConnectedFor(booking.interviewerUserIds);
    const organiser = live[0];
    if (!organiser) return null;

    const adapter = this.registry.get(organiser.provider);
    if (!adapter?.isConfigured()) return null;

    const token = await this.connections.resolveRefreshToken(organiser.userId, organiser.provider);
    if (!token) return null;

    try {
      const grant = await adapter.accessToken(token);
      const eventId = await adapter.createEvent(grant.accessToken, booking);
      return { eventId };
    } catch (error) {
      if (error instanceof ProviderCredentialError) {
        await this.connections.markDisconnectedFor(organiser.userId, organiser.provider);
        this.logger.warn(
          `${organiser.provider}: credential rejected during event creation; connection disconnected`,
        );
        return null;
      }
      /*
       * FR6.3 — a provider fault must not fail the booking. Both scheduling
       * call sites already `.catch(() => null)`, and returning null here says
       * the same thing one layer earlier: the interview stands with no
       * calendar_event_id.
       */
      this.logger.warn(`${organiser.provider}: event creation failed; booking stands without it`);
      return null;
    }
  }
}
