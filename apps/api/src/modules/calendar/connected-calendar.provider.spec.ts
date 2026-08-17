import { CalendarProvider as Provider } from '@prisma/client';
import type { CalendarBooking } from '../interviews/calendar.provider';
import { ConnectedCalendarProvider } from './connected-calendar.provider';
import type { CalendarConnectionsService } from './calendar-connections.service';
import type { CalendarProviderRegistry } from './calendar-provider.registry';
import {
  ProviderCredentialError,
  ProviderUnavailableError,
  type ProviderAdapter,
} from './providers/provider-adapter';

/**
 * The per-interviewer router (D34, D35).
 *
 * Unit tests with stub adapters, because the behaviour that matters here is
 * the routing and the three-state distinction — not what Google or Microsoft
 * return. The real adapters cannot be exercised without live client
 * credentials, and pretending otherwise with a recorded fixture would test the
 * fixture rather than the provider.
 */
describe('ConnectedCalendarProvider (FR6.1)', () => {
  const window = () => ({
    from: new Date('2026-09-01T09:00:00.000Z'),
    to: new Date('2026-09-01T17:00:00.000Z'),
  });

  const booking = (userIds: string[]) => ({
    jobTitle: 'Backend Engineer',
    candidateName: 'A Candidate',
    startsAt: new Date('2026-09-01T10:00:00.000Z'),
    endsAt: new Date('2026-09-01T11:00:00.000Z'),
    timezone: 'Europe/London',
    interviewerEmails: userIds.map((id) => `${id}@provider.example`),
    interviewerUserIds: userIds,
  });

  const adapter = (over: Partial<ProviderAdapter> = {}): ProviderAdapter => ({
    isConfigured: () => true,
    authorizationUrl: () => 'https://provider.example/auth',
    exchangeCode: async () => ({
      refreshToken: 'r',
      accountIdentifier: 'a@provider.example',
      expiresAt: null,
    }),
    accessToken: async () => ({ accessToken: 'access-token', expiresAt: null }),
    freeBusy: async () => new Map(),
    createEvent: async () => 'event-1',
    revoke: async () => undefined,
    ...over,
  });

  const build = (opts: {
    configured?: boolean;
    adapter?: ProviderAdapter;
    connections?: { userId: string; provider: Provider; accountIdentifier: string }[];
    onDisconnect?: jest.Mock;
  }) => {
    const disconnect = opts.onDisconnect ?? jest.fn();
    const connections = {
      listConnectedFor: async () => opts.connections ?? [],
      resolveRefreshToken: async () => 'stored-refresh-token',
      markDisconnectedFor: disconnect,
    } as unknown as CalendarConnectionsService;

    const registry = {
      anyConfigured: () => opts.configured ?? true,
      get: () => opts.adapter ?? adapter(),
      configured: () => ((opts.configured ?? true) ? [Provider.google] : []),
    } as unknown as CalendarProviderRegistry;

    return { provider: new ConnectedCalendarProvider(connections, registry), disconnect };
  };

  describe('no provider configured — manual mode (FR6.3, D15)', () => {
    it('still reports itself available so scheduling completes', () => {
      const { provider } = build({ configured: false });
      expect(provider.isAvailable()).toBe(true);
    });

    it('returns null availability, matching ManualCalendarProvider', async () => {
      const { provider } = build({ configured: false });
      expect(await provider.getAvailability(['u1'], window())).toBeNull();
    });

    it('creates no event, leaving calendar_event_id null', async () => {
      const { provider } = build({ configured: false });
      expect(await provider.createEvent(booking(['u1']))).toBeNull();
    });
  });

  describe('availability routing', () => {
    it('returns busy blocks keyed by the provider account, not the user id', async () => {
      const busy = new Map([
        ['one@provider.example', [{ startsAt: window().from, endsAt: window().to }]],
      ]);
      const { provider } = build({
        adapter: adapter({ freeBusy: async () => busy }),
        connections: [
          { userId: 'u1', provider: Provider.google, accountIdentifier: 'one@provider.example' },
        ],
      });

      const result = await provider.getAvailability(['u1'], window());

      // D37 — the response carries the authorised account, never users.email.
      expect(result).toEqual([
        { email: 'one@provider.example', busy: [{ startsAt: window().from, endsAt: window().to }] },
      ]);
    });

    it('reports a connected interviewer with nothing booked as an empty busy list', async () => {
      const { provider } = build({
        adapter: adapter({ freeBusy: async () => new Map() }),
        connections: [
          { userId: 'u1', provider: Provider.google, accountIdentifier: 'free@provider.example' },
        ],
      });

      // "Connected and free" is an entry with no blocks — distinct from
      // "not connected", which is an omission the controller reports.
      expect(await provider.getAvailability(['u1'], window())).toEqual([
        { email: 'free@provider.example', busy: [] },
      ]);
    });

    it('omits an unconnected interviewer rather than failing the request', async () => {
      const { provider } = build({ connections: [] });

      // The controller turns this omission into `notConnected`. Crucially it
      // is NOT an error: nobody linking a calendar is not an outage.
      expect(await provider.getAvailability(['u1', 'u2'], window())).toEqual([]);
    });

    it('surfaces a provider outage as ProviderUnavailableError', async () => {
      const { provider } = build({
        adapter: adapter({
          freeBusy: async () => {
            throw new ProviderUnavailableError('google');
          },
        }),
        connections: [
          { userId: 'u1', provider: Provider.google, accountIdentifier: 'one@provider.example' },
        ],
      });

      await expect(provider.getAvailability(['u1'], window())).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    });

    it('disconnects rather than retrying when the credential is rejected (D36)', async () => {
      const disconnect = jest.fn();
      const { provider } = build({
        onDisconnect: disconnect,
        adapter: adapter({
          accessToken: async () => {
            throw new ProviderCredentialError('google');
          },
        }),
        connections: [
          { userId: 'u1', provider: Provider.google, accountIdentifier: 'one@provider.example' },
        ],
      });

      // Permanent failure: the connection is dropped and the request still
      // answers, rather than raising an outage the caller would retry.
      await expect(provider.getAvailability(['u1'], window())).resolves.toEqual([]);
      expect(disconnect).toHaveBeenCalledWith('u1', Provider.google);
    });
  });

  describe('event creation', () => {
    it('creates the event on the first connected interviewer’s calendar', async () => {
      const createEvent = jest.fn(async () => 'provider-event-9');
      const { provider } = build({
        adapter: adapter({ createEvent }),
        connections: [
          { userId: 'u2', provider: Provider.google, accountIdentifier: 'two@provider.example' },
        ],
      });

      expect(await provider.createEvent(booking(['u1', 'u2']))).toEqual({
        eventId: 'provider-event-9',
      });
      expect(createEvent).toHaveBeenCalledTimes(1);
    });

    it('returns null when nobody on the panel has a calendar (FR6.3)', async () => {
      const { provider } = build({ connections: [] });
      expect(await provider.createEvent(booking(['u1']))).toBeNull();
    });

    it('returns null rather than throwing when the provider fails (FR6.3)', async () => {
      const { provider } = build({
        adapter: adapter({
          createEvent: async () => {
            throw new ProviderUnavailableError('google');
          },
        }),
        connections: [
          { userId: 'u1', provider: Provider.google, accountIdentifier: 'one@provider.example' },
        ],
      });

      // A provider fault must never fail the booking — the interview stands
      // with no calendar_event_id.
      expect(await provider.createEvent(booking(['u1']))).toBeNull();
    });

    it('disconnects when the credential is rejected during creation (D36)', async () => {
      const disconnect = jest.fn();
      const { provider } = build({
        onDisconnect: disconnect,
        adapter: adapter({
          createEvent: async () => {
            throw new ProviderCredentialError('google');
          },
        }),
        connections: [
          { userId: 'u1', provider: Provider.google, accountIdentifier: 'one@provider.example' },
        ],
      });

      expect(await provider.createEvent(booking(['u1']))).toBeNull();
      expect(disconnect).toHaveBeenCalledWith('u1', Provider.google);
    });

    it('passes only interviewers as attendees — never the candidate (D41)', async () => {
      const createEvent = jest.fn(async (_token: string, _b: CalendarBooking) => 'e1');
      const { provider } = build({
        adapter: adapter({ createEvent }),
        connections: [
          { userId: 'u1', provider: Provider.google, accountIdentifier: 'one@provider.example' },
        ],
      });

      await provider.createEvent(booking(['u1']));

      const passed = createEvent.mock.calls[0]![1];
      expect(passed.interviewerEmails).toEqual(['u1@provider.example']);
      // The candidate's name is on the booking for the title, but their
      // address is nowhere in the attendee list — it is never even carried.
      expect(JSON.stringify(passed)).not.toContain('candidateEmail');
    });
  });
});
