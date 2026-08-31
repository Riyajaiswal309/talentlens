import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';

/**
 * FR6.1 — the interviewer's own calendar connections.
 *
 * EVERY ROUTE HERE IS ABOUT THE CALLER'S OWN CALENDAR. `GET /v1/calendar/connections`
 * returns "own only" by construction — there is no route that lists another
 * user's connections, and no parameter here could ask for one. Disconnecting
 * someone else's calendar is an Administrator action on a different path
 * (`…/users/:userId/:provider`), which this module deliberately does not wrap.
 *
 * NO CREDENTIAL EVER REACHES THIS LAYER. The API's connection projection is
 * `id, provider, accountIdentifier, status, expiresAt, disconnectedAt` and the
 * timestamps — no token, ciphertext or key. The OAuth `code` passes through
 * once on its way to `/complete` and is never stored.
 */

export const CALENDAR_PROVIDERS = ['google', 'microsoft'] as const;
export type CalendarProviderId = (typeof CALENDAR_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<CalendarProviderId, string> = {
  google: 'Google Calendar',
  microsoft: 'Microsoft Outlook',
};

/** Mirrors `CalendarConnectionResponse`. Deliberately no credential field. */
export interface CalendarConnection {
  id: string;
  provider: string;
  accountIdentifier: string;
  status: string;
  expiresAt: string | null;
  disconnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Whether this deployment holds client credentials for a provider. */
export interface ProviderStatus {
  provider: string;
  configured: boolean;
}

export function useCalendarConnections() {
  return useQuery({
    queryKey: ['calendar-connections'],
    queryFn: ({ signal }) =>
      api
        .get<{ data: CalendarConnection[] }>('/calendar/connections', { signal })
        .then((response) => response.data),
  });
}

/**
 * Which providers this server can actually start a consent flow for.
 *
 * READ SEPARATELY RATHER THAN INFERRED FROM A FAILED CONNECT. The only other
 * way to learn this is to call `authorize` and read its 503 — but `authorize`
 * mints single-use CSRF state, so probing it on render would spend state
 * tokens as a side effect. This endpoint exists to answer the question without
 * that cost.
 */
export function useCalendarProviders() {
  return useQuery({
    queryKey: ['calendar-providers'],
    queryFn: ({ signal }) =>
      api
        .get<{ data: ProviderStatus[] }>('/calendar/connections/providers', { signal })
        .then((response) => response.data),
    // Configuration changes only with a server restart.
    staleTime: 5 * 60_000,
  });
}

/**
 * Step one of consent: ask the server for the provider's authorization URL.
 *
 * The server mints the `state` — the client never invents it. That state is the
 * CSRF defence *and* the second identity check: it is bound to the initiating
 * user and consumed exactly once, so a captured `code` cannot be completed by
 * anyone else.
 */
export function useBeginCalendarConnect() {
  return useMutation({
    mutationFn: (provider: CalendarProviderId) =>
      api.post<{ authorizationUrl: string }>(`/calendar/connections/${provider}/authorize`),
  });
}

/**
 * Step two: hand the provider's `code` and `state` back to our own API.
 *
 * The redirect lands on the FRONTEND, not the API, because a provider redirect
 * cannot carry a Bearer token. This call re-enters the authenticated session
 * the user already holds, which is what keeps both halves of the flow inside
 * that session without a public callback.
 */
export function useCompleteCalendarConnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      provider,
      code,
      state,
      error,
    }: {
      provider: string;
      code?: string;
      state: string;
      error?: string;
    }) =>
      api.post<CalendarConnection>(`/calendar/connections/${provider}/complete`, {
        state,
        ...(code ? { code } : {}),
        ...(error ? { error } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['calendar-connections'] });
    },
  });
}

export function useDisconnectCalendar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) =>
      api.delete<CalendarConnection>(`/calendar/connections/${provider}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['calendar-connections'] });
    },
  });
}

/**
 * The live connection for a provider, if there is one.
 *
 * A row with `status: 'disconnected'` is history, not a connection — the
 * server keeps it so the audit trail has something to point at. Treating it as
 * connected would tell the user their calendar is linked when it is not.
 */
export function liveConnectionFor(
  connections: CalendarConnection[] | undefined,
  provider: string,
): CalendarConnection | undefined {
  return connections?.find((c) => c.provider === provider && c.status === 'connected');
}
