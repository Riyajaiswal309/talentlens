import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';
import type { InterviewResponse } from '../candidates/useApplication';

/**
 * FR6.1–FR6.3 — the recruiter's side of scheduling.
 *
 * EVERY ROUTE HERE IS RECRUITER/ADMIN ON THE SERVER, and the recruiter console
 * is already gated to exactly those two roles (`RECRUITER_APP_ROLES`), so these
 * hooks are never mounted for anyone the API would refuse. A Hiring Manager
 * cannot reach the screen that uses them at all.
 */

/* -------------------------------------------------------------------------- */
/* Interviewer picker (Phase 1's GET /v1/interviewers)                         */
/* -------------------------------------------------------------------------- */

/**
 * One selectable interviewer.
 *
 * NO `name` FIELD, because `users` has no name column. The email is the label
 * the API returns and the only one shown — nothing here derives a display name
 * from it, which would be inventing an identity the system does not hold.
 */
export interface Interviewer {
  id: string;
  email: string;
  role: string;
}

/** The DTO caps `limit` at 100; a tenant panel list is far smaller than that. */
const INTERVIEWER_PAGE_SIZE = 100;

export function useInterviewers() {
  return useQuery({
    queryKey: ['interviewers'],
    queryFn: ({ signal }) =>
      api
        .get<{ data: Interviewer[]; nextCursor: string | null }>('/interviewers', {
          query: { limit: INTERVIEWER_PAGE_SIZE },
          signal,
        })
        .then((response) => response.data),
  });
}

/* -------------------------------------------------------------------------- */
/* Availability (FR6.1)                                                        */
/* -------------------------------------------------------------------------- */

export interface AvailabilityQuery {
  interviewerIds: string[];
  from: string;
  to: string;
}

export interface AvailabilityResponse {
  from: string;
  to: string;
  availability: { email: string; busy: { startsAt: string; endsAt: string }[] }[];
  /**
   * Interviewers with no usable calendar, BY USER ID. The server treats this as
   * a reportable state rather than a failure (D42): no connection, a
   * disconnected one, and an id outside the tenant all land here identically.
   */
  notConnected: string[];
}

/**
 * Free/busy for a window.
 *
 * DRIVEN BY AN EXPLICIT PARAMS OBJECT rather than firing on every keystroke —
 * the recruiter presses "Check calendars" and the query runs for exactly the
 * interviewers and window on screen at that moment.
 *
 * A 503 here means a CONFIGURED provider did not answer; no provider configured
 * at all is a 200 with everyone in `notConnected`, which is manual-scheduling
 * mode and not an error. The caller must render those two differently.
 */
export function useAvailability(params: AvailabilityQuery | null) {
  return useQuery({
    queryKey: [
      'interview-availability',
      params?.interviewerIds.join(',') ?? null,
      params?.from ?? null,
      params?.to ?? null,
    ],
    queryFn: ({ signal }) =>
      api.get<AvailabilityResponse>('/interviews/availability', {
        query: {
          interviewerIds: params!.interviewerIds,
          from: params!.from,
          to: params!.to,
        },
        signal,
      }),
    enabled: Boolean(params && params.interviewerIds.length > 0),
    // Free/busy is a point-in-time read; refetching it silently would let the
    // grid disagree with what the recruiter pressed the button to see.
    staleTime: 60_000,
    retry: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Creating an interview (FR6.2 self-service / FR6.3 manual)                   */
/* -------------------------------------------------------------------------- */

export interface CreateInterviewSlot {
  startsAt: string;
  endsAt: string;
  timezone: string;
}

/**
 * The two shapes `POST /v1/interviews` accepts.
 *
 * MUTUALLY EXCLUSIVE ON THE SERVER: sending both `slots` and `scheduledAt` is a
 * 400, and so is sending neither. The union here makes that impossible to get
 * wrong from this client rather than relying on the round trip to say so.
 */
export type CreateInterviewInput =
  | { applicationId: string; interviewerIds: string[]; slots: CreateInterviewSlot[] }
  | {
      applicationId: string;
      interviewerIds: string[];
      scheduledAt: string;
      timezone: string;
    };

/**
 * The created interview, plus the scheduling token on the self-service path.
 *
 * `schedulingToken` is absent entirely on the manual path, where no link
 * exists — hence optional rather than nullable.
 */
export type CreateInterviewResult = InterviewResponse & {
  schedulingToken?: string;
  expiresAt?: string;
};

export function useCreateInterview(applicationId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInterviewInput) =>
      api.post<CreateInterviewResult>('/interviews', input),
    onSuccess: () => {
      // The panel below the form lists interviews for this application.
      void queryClient.invalidateQueries({
        queryKey: ['application-interviews', applicationId],
      });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Cancellation (FR6)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `POST /v1/interviews/:id/cancel` — Recruiter and Admin only.
 *
 * CANCELLING ALSO KILLS THE LINK. The server sets `CANCELLED`, and both
 * scheduling routes refuse anything that is not `PENDING_SELECTION`, so an
 * outstanding self-service link stops working at the same moment. There is no
 * second call to make.
 *
 * WHAT IT DOES NOT DO: remove an event already created in someone's external
 * calendar. The provider abstraction has no delete, so `calendarEventId` is
 * left intact as a true record of what exists out there, and the UI says the
 * invitation must be withdrawn by hand.
 */
export function useCancelInterview(applicationId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (interviewId: string) =>
      api.post<InterviewResponse>(`/interviews/${interviewId}/cancel`),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['application-interviews', applicationId],
      });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Time helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The recruiter's own IANA zone, used as the zone for every time they type.
 *
 * TIMES ARE ENTERED AND SENT IN THIS ZONE, deliberately. A `datetime-local`
 * input yields a wall-clock string with no offset, and `new Date(value)` reads
 * it in the browser's zone — so treating that zone as the slot's zone is the
 * one interpretation that needs no offset arithmetic and cannot drift across a
 * DST boundary. Offering a zone dropdown here would mean re-deriving offsets by
 * hand for a zone the browser is not in, which is exactly where these bugs live.
 */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `datetime-local` value -> ISO instant, read in the browser's zone. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function addMinutesIso(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/** The `datetime-local` floor: no interview may be offered in the past. */
export function nowLocalInputValue(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

export function formatDateTimeInZone(iso: string, timezone: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/** Durations offered for a slot. The API takes explicit ends, not a length. */
export const SLOT_DURATIONS = [30, 45, 60, 90] as const;

/** `InterviewSlotDto` — at least one, at most twenty. */
export const MAX_SLOTS = 20;
/** `CreateInterviewDto` — at most ten interviewers. */
export const MAX_INTERVIEWERS = 10;
