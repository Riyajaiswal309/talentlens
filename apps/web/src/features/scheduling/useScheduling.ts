import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api-client';
import { ApiError } from '../../lib/problem-details';

/**
 * FR6.2 — the candidate's self-service scheduling link.
 *
 * UNAUTHENTICATED BY DESIGN, and more strictly so than the careers pages. Both
 * routes are `@Public()` on the server because, in the controller's own words,
 * "the scheduling token IS the credential" — it is an HMAC-signed string naming
 * exactly one interview. There is no session here and there must never be one:
 * a candidate has no account in this build.
 *
 * `skipAuthRecovery` IS LOAD-BEARING ON BOTH CALLS. A 401 from these endpoints
 * is a domain answer — "this link is not valid or has expired" — not a stale
 * access token. Without the flag the client would treat it as an expired
 * session and fire a silent `POST /v1/auth/refresh`, which for a signed-in
 * recruiter previewing a link would swap the honest expiry screen for a
 * refresh round-trip, and for a candidate would fire a pointless request with
 * no cookie behind it.
 */

/** `GET /v1/scheduling/:token` — mirrors `SchedulingOffer` on the server. */
export interface SchedulingOffer {
  jobTitle: string;
  /**
   * Derived server-side from each interviewer's email local-part. `users` has
   * no name column, so this is the closest thing to a name the schema holds —
   * it is a courtesy label, not an identity, and nothing here should present it
   * as verified.
   */
  interviewerNames: string[];
  slots: SchedulingSlot[];
  expiresAt: string;
}

export interface SchedulingSlot {
  slotId: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
}

/** `POST /v1/scheduling/:token/confirm` — mirrors `SchedulingConfirmation`. */
export interface SchedulingConfirmation {
  interviewId: string;
  scheduledAt: string;
  /**
   * Null whenever no calendar provider is configured, which is the norm in this
   * build. FR6.3 treats that as a COMPLETE booking, so the UI must not read a
   * null here as a partial failure.
   */
  calendarEventId: string | null;
}

export function useSchedulingOffer(token: string | undefined) {
  return useQuery({
    queryKey: ['scheduling-offer', token ?? null],
    queryFn: ({ signal }) =>
      api.get<SchedulingOffer>(`/scheduling/${encodeURIComponent(token!)}`, {
        signal,
        skipAuthRecovery: true,
      }),
    enabled: Boolean(token),
    /*
     * A 401/404/410 is a settled answer about this link, not a blip. Retrying
     * would delay the explanation the candidate needs by several seconds and
     * would re-send a token that has already been judged invalid.
     */
    retry: (failureCount, error) => !(error instanceof ApiError) && failureCount < 2,
  });
}

export function useConfirmSlot(token: string | undefined) {
  return useMutation({
    mutationFn: (slotId: string) =>
      api.post<SchedulingConfirmation>(
        `/scheduling/${encodeURIComponent(token!)}/confirm`,
        { slotId },
        { skipAuthRecovery: true },
      ),
  });
}

/**
 * How the page should react to a failure, keyed on the status the server sent.
 *
 * EVERY BRANCH IS THE SERVER'S OWN DISTINCTION, not a guess. 401 and 410 are
 * terminal states with nothing to retry; 409 and 400 mean the offer on screen
 * is stale, so the fix is to re-read it; 503 is FR6.3's manual-scheduling
 * fallback and must say so rather than implying the booking failed outright.
 */
export type SchedulingFailure =
  | 'invalid'
  | 'gone'
  | 'unknown'
  | 'slot-taken'
  | 'slot-rejected'
  | 'calendar-unavailable'
  | 'network';

export function classifyFailure(error: unknown): SchedulingFailure {
  if (!(error instanceof ApiError)) return 'network';

  switch (error.status) {
    case 401:
      return 'invalid';
    case 410:
      return 'gone';
    case 404:
      return 'unknown';
    case 409:
      return 'slot-taken';
    case 400:
      return 'slot-rejected';
    case 503:
      return 'calendar-unavailable';
    default:
      return 'network';
  }
}

/** True when re-reading the offer is the sensible next step. */
export function isStaleOffer(failure: SchedulingFailure): boolean {
  return failure === 'slot-taken' || failure === 'slot-rejected';
}

/**
 * Format a slot as a single human line.
 *
 * RENDERED IN THE SLOT'S OWN TIMEZONE, not the browser's. The recruiter offered
 * "10:00 in Asia/Kolkata"; showing it converted to whatever zone the candidate's
 * laptop is set to invites them to arrive an hour out when the two disagree
 * about DST. The zone is named on screen for the same reason.
 */
export function formatSlot(slot: SchedulingSlot): string {
  const start = new Date(slot.startsAt);
  const end = new Date(slot.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';

  try {
    const day = new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: slot.timezone,
    }).format(start);
    const time = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: slot.timezone,
    });
    return `${day}, ${time.format(start)} – ${time.format(end)}`;
  } catch {
    // An unrecognised IANA zone would otherwise throw and blank the whole list.
    return `${start.toLocaleString()} – ${end.toLocaleTimeString()}`;
  }
}

/** Minutes between the two ends of a slot, for the "45 minutes" hint. */
export function slotDurationMinutes(slot: SchedulingSlot): number {
  const ms = new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60000) : 0;
}

export function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  });
}
