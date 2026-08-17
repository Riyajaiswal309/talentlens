import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import type { BusyBlock, CalendarBooking } from '../../interviews/calendar.provider';
import { eventTitle } from './google-calendar.adapter';
import {
  type AccessGrant,
  type AuthorisedAccount,
  type ProviderAdapter,
  ProviderCredentialError,
  ProviderUnavailableError,
} from './provider-adapter';

/**
 * The narrowest Graph scopes that satisfy FR6.1 (D35).
 *
 *   Calendars.ReadWrite  — Graph has no free/busy-only delegated scope; the
 *                          `getSchedule` call this adapter uses requires
 *                          Calendars.ReadWrite. That is broader than Google's
 *                          `calendar.freebusy`, and it is a real asymmetry
 *                          between the two providers rather than a choice made
 *                          here — Microsoft simply does not offer a narrower
 *                          delegated scope for schedule reads.
 *   User.Read            — capture account_identifier explicitly (D37).
 *   offline_access       — yields the refresh token D36 persists.
 *
 * The adapter still only ever CALLS getSchedule and event creation, so the
 * data crossing the seam is the same busy-intervals-only shape as Google's.
 */
const SCOPES = ['Calendars.ReadWrite', 'User.Read', 'offline_access'];

const AUTHORITY_BASE = 'https://login.microsoftonline.com';

/**
 * Microsoft Outlook / Graph, behind the same `ProviderAdapter` (D35).
 *
 * MSAL is used for the OAuth halves and the raw Graph client for calendar
 * calls, because MSAL does not model free/busy at all. Neither library's types
 * escape this file.
 */
@Injectable()
export class MicrosoftCalendarAdapter implements ProviderAdapter {
  private readonly logger = new Logger(MicrosoftCalendarAdapter.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly tenant: string;

  constructor(config: ConfigService) {
    this.clientId = config.get<string>('MICROSOFT_CALENDAR_CLIENT_ID') ?? '';
    this.clientSecret = config.get<string>('MICROSOFT_CALENDAR_CLIENT_SECRET') ?? '';
    this.redirectUri = config.get<string>('MICROSOFT_CALENDAR_REDIRECT_URI') ?? '';
    // `common` lets any work or personal account consent; a single-tenant
    // deployment overrides it with its directory id.
    this.tenant = config.get<string>('MICROSOFT_CALENDAR_TENANT') ?? 'common';
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  private msal(): ConfidentialClientApplication {
    return new ConfidentialClientApplication({
      auth: {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        authority: `${AUTHORITY_BASE}/${this.tenant}`,
      },
    });
  }

  /**
   * MSAL's authorization-URL builder is async, so this returns a synchronous
   * URL assembled from the same parameters. The interface is synchronous
   * because Google's is, and one shape for both providers is the point of D35.
   */
  authorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      response_mode: 'query',
      scope: SCOPES.join(' '),
      state,
      // Force consent so a re-connect reliably reissues a refresh token,
      // matching the Google adapter's reasoning.
      prompt: 'consent',
    });
    return `${AUTHORITY_BASE}/${this.tenant}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<AuthorisedAccount> {
    // ONE instance for both the exchange and the cache read: MSAL writes the
    // refresh token into the cache of the application that performed the
    // exchange, so a second instance would see an empty cache.
    const app = this.msal();

    let result;
    try {
      result = await app.acquireTokenByCode({
        code,
        scopes: SCOPES,
        redirectUri: this.redirectUri,
      });
    } catch (error) {
      throw new ProviderCredentialError('microsoft', error);
    }

    /*
     * MSAL hides the refresh token behind its token cache rather than
     * returning it, so it is read from the serialised cache. D36 requires the
     * refresh token itself, because a cache blob is not what the adapter needs
     * back and would tie stored state to an MSAL version.
     */
    const refreshToken = extractRefreshToken(app.getTokenCache().serialize());
    if (!refreshToken) {
      throw new ProviderCredentialError(
        'microsoft',
        new Error('Microsoft returned no refresh token; re-consent is required'),
      );
    }

    // D37 — the authorised account, from the provider.
    const accountIdentifier =
      result?.account?.username ??
      (result?.idTokenClaims as { preferred_username?: string })?.preferred_username;

    if (!accountIdentifier) {
      throw new ProviderCredentialError(
        'microsoft',
        new Error('Microsoft returned no account username; cannot record account_identifier'),
      );
    }

    return {
      refreshToken,
      accountIdentifier,
      expiresAt: result?.expiresOn ?? null,
    };
  }

  async accessToken(refreshToken: string): Promise<AccessGrant> {
    const app = this.msal();
    try {
      /*
       * `acquireTokenByRefreshToken` is the only MSAL path that accepts a raw
       * refresh token, which is what D36 stores. It is marked internal by
       * MSAL but is the documented mechanism for exactly this migration case.
       */
      const result = await app.acquireTokenByRefreshToken({ refreshToken, scopes: SCOPES });

      if (!result?.accessToken) {
        throw new ProviderCredentialError('microsoft', new Error('no access token returned'));
      }
      return { accessToken: result.accessToken, expiresAt: result.expiresOn ?? null };
    } catch (error) {
      if (error instanceof ProviderCredentialError) throw error;
      throw isInvalidGrant(error)
        ? new ProviderCredentialError('microsoft', error)
        : new ProviderUnavailableError('microsoft', error);
    }
  }

  private graph(accessToken: string): Client {
    return Client.init({ authProvider: (done) => done(null, accessToken) });
  }

  async freeBusy(
    accessToken: string,
    accountIdentifiers: string[],
    window: { from: Date; to: Date },
  ): Promise<Map<string, BusyBlock[]>> {
    try {
      const response = await this.graph(accessToken)
        .api('/me/calendar/getSchedule')
        .post({
          schedules: accountIdentifiers,
          startTime: { dateTime: window.from.toISOString(), timeZone: 'UTC' },
          endTime: { dateTime: window.to.toISOString(), timeZone: 'UTC' },
          // Coarsest granularity Graph accepts; FR6.1 needs intervals, not
          // minute-level detail.
          availabilityViewInterval: 30,
        });

      const result = new Map<string, BusyBlock[]>();
      for (const schedule of (response?.value ?? []) as GraphSchedule[]) {
        const id = schedule.scheduleId;
        if (!id) continue;

        /*
         * `scheduleItems` can carry a subject when the caller has rights to
         * see it. Only the interval is read — the seam reports WHEN someone is
         * committed and never what they are doing.
         */
        result.set(
          id,
          (schedule.scheduleItems ?? [])
            .filter((item) => item.start?.dateTime && item.end?.dateTime)
            .map((item) => ({
              startsAt: parseGraphDate(item.start!.dateTime!),
              endsAt: parseGraphDate(item.end!.dateTime!),
            })),
        );
      }
      return result;
    } catch (error) {
      throw isInvalidGrant(error)
        ? new ProviderCredentialError('microsoft', error)
        : new ProviderUnavailableError('microsoft', error);
    }
  }

  async createEvent(accessToken: string, booking: CalendarBooking): Promise<string> {
    try {
      const created = await this.graph(accessToken)
        .api('/me/events')
        .post({
          subject: eventTitle(booking),
          start: { dateTime: booking.startsAt.toISOString(), timeZone: booking.timezone },
          end: { dateTime: booking.endsAt.toISOString(), timeZone: booking.timezone },
          // D41 — interviewers only; the candidate is never an attendee, and
          // there is no body, location or online meeting.
          attendees: booking.interviewerEmails.map((email) => ({
            emailAddress: { address: email },
            type: 'required',
          })),
        });

      const id = (created as { id?: string })?.id;
      if (!id) throw new ProviderUnavailableError('microsoft', new Error('no event id returned'));
      return id;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw isInvalidGrant(error)
        ? new ProviderCredentialError('microsoft', error)
        : new ProviderUnavailableError('microsoft', error);
    }
  }

  async revoke(_refreshToken: string): Promise<void> {
    /*
     * Graph exposes no per-token revocation for a delegated grant — only
     * `revokeSignInSessions`, which requires elevated privileges and severs
     * every session the user has, far beyond disconnecting a calendar.
     *
     * So this is a deliberate no-op, and it is safe: D36's guarantee is local
     * invalidation, the stored credential is already cleared by the caller,
     * and the user can withdraw consent from their Microsoft account page.
     * Recorded here rather than silently omitted.
     */
    this.logger.log(
      'microsoft: no per-token revocation endpoint exists for delegated grants; ' +
        'the stored credential has been destroyed locally',
    );
  }
}

interface GraphSchedule {
  scheduleId?: string;
  scheduleItems?: { start?: { dateTime?: string }; end?: { dateTime?: string } }[];
}

/** Graph returns local date-times without an offset; they are UTC by request. */
function parseGraphDate(value: string): Date {
  return new Date(value.endsWith('Z') ? value : `${value}Z`);
}

function isInvalidGrant(error: unknown): boolean {
  const text = describe(error).toLowerCase();
  return (
    text.includes('invalid_grant') ||
    text.includes('aadsts70008') || // expired or revoked
    text.includes('aadsts50173') || // credential changed
    text.includes('invalidauthenticationtoken')
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pull the refresh token out of MSAL's serialised cache. */
function extractRefreshToken(cache: string): string | undefined {
  if (!cache) return undefined;
  try {
    const parsed = JSON.parse(cache) as { RefreshToken?: Record<string, { secret?: string }> };
    const entries = Object.values(parsed.RefreshToken ?? {});
    return entries[0]?.secret;
  } catch {
    return undefined;
  }
}
