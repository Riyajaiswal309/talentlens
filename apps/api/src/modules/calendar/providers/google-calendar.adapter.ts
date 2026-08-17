import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import type { BusyBlock, CalendarBooking } from '../../interviews/calendar.provider';
import {
  type AccessGrant,
  type AuthorisedAccount,
  type ProviderAdapter,
  ProviderCredentialError,
  ProviderUnavailableError,
} from './provider-adapter';

/**
 * The narrowest scopes that satisfy FR6.1 (D35).
 *
 *   calendar.freebusy  — read WHEN someone is busy, never what they are doing.
 *                        This is the scope FR6.1 actually needs and it cannot
 *                        read event titles, attendees or locations at all.
 *   calendar.events    — create the interview event (D41). Does not grant
 *                        access to the wider calendar.
 *   userinfo.email     — capture account_identifier explicitly (D37).
 *
 * Deliberately NOT requested: full `calendar` read/write. A broader scope
 * would let this system read every event on an employee's calendar, which
 * nothing in FR6.1 asks for.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

/**
 * Google Calendar, behind `ProviderAdapter` (D35).
 *
 * Credentials come from configuration, never from source (§24.3 Secrets
 * Manager). An unconfigured deployment reports `isConfigured() === false`, and
 * the composite provider then treats Google as absent rather than broken —
 * "no provider" and "provider down" are different answers (F).
 */
@Injectable()
export class GoogleCalendarAdapter implements ProviderAdapter {
  private readonly logger = new Logger(GoogleCalendarAdapter.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(config: ConfigService) {
    this.clientId = config.get<string>('GOOGLE_CALENDAR_CLIENT_ID') ?? '';
    this.clientSecret = config.get<string>('GOOGLE_CALENDAR_CLIENT_SECRET') ?? '';
    this.redirectUri = config.get<string>('GOOGLE_CALENDAR_REDIRECT_URI') ?? '';
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  /**
   * A fresh client per call — it holds credentials and must not be shared.
   *
   * The return type is inferred from `googleapis` rather than imported from
   * `google-auth-library`, which is only a transitive dependency: importing it
   * directly would couple this file to a package the project never declared.
   */
  private client() {
    return new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
  }

  authorizationUrl(state: string): string {
    return this.client().generateAuthUrl({
      // `offline` is what yields a refresh token at all; without it the grant
      // would die with the access token and D36's persistence would be moot.
      access_type: 'offline',
      // Forces the consent screen so Google reissues a refresh token even for
      // an account that previously consented — otherwise a re-connect can
      // return no refresh token and silently produce a dead connection.
      prompt: 'consent',
      scope: SCOPES,
      state,
      include_granted_scopes: false,
    });
  }

  async exchangeCode(code: string): Promise<AuthorisedAccount> {
    const client = this.client();

    let tokens;
    try {
      ({ tokens } = await client.getToken(code));
    } catch (error) {
      // A bad or replayed code is the caller's problem, not an outage.
      throw new ProviderCredentialError('google', error);
    }

    if (!tokens.refresh_token) {
      throw new ProviderCredentialError(
        'google',
        new Error('Google returned no refresh token; re-consent is required'),
      );
    }

    /*
     * D37 — the account identifier is read from the provider, never assumed
     * from users.email. The id token carries the address Google actually
     * authorised, which may differ from the TalentLens login entirely.
     */
    client.setCredentials(tokens);
    let email: string | undefined;
    try {
      const info = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
      email = info.data.email ?? undefined;
    } catch (error) {
      throw new ProviderUnavailableError('google', error);
    }

    if (!email) {
      throw new ProviderCredentialError(
        'google',
        new Error('Google returned no account email; cannot record account_identifier'),
      );
    }

    return {
      refreshToken: tokens.refresh_token,
      accountIdentifier: email,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    };
  }

  async accessToken(refreshToken: string): Promise<AccessGrant> {
    const client = this.client();
    client.setCredentials({ refresh_token: refreshToken });

    try {
      const { credentials } = await client.refreshAccessToken();
      if (!credentials.access_token) {
        throw new ProviderCredentialError('google', new Error('no access token returned'));
      }
      return {
        accessToken: credentials.access_token,
        expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
      };
    } catch (error) {
      if (error instanceof ProviderCredentialError) throw error;
      // `invalid_grant` means the user revoked consent or the token expired:
      // permanent, so D36 says disconnect rather than retry. Anything else is
      // treated as transient.
      throw isInvalidGrant(error)
        ? new ProviderCredentialError('google', error)
        : new ProviderUnavailableError('google', error);
    }
  }

  async freeBusy(
    accessToken: string,
    accountIdentifiers: string[],
    window: { from: Date; to: Date },
  ): Promise<Map<string, BusyBlock[]>> {
    const auth = this.client();
    auth.setCredentials({ access_token: accessToken });

    try {
      const response = await google.calendar({ version: 'v3', auth }).freebusy.query({
        requestBody: {
          timeMin: window.from.toISOString(),
          timeMax: window.to.toISOString(),
          items: accountIdentifiers.map((id) => ({ id })),
        },
      });

      const result = new Map<string, BusyBlock[]>();
      for (const [id, calendar] of Object.entries(response.data.calendars ?? {})) {
        /*
         * BUSY INTERVALS ONLY. `freebusy.query` returns no summary, attendees
         * or location, which is precisely why this endpoint is used instead of
         * listing events — the seam cannot leak private calendar detail it was
         * never given.
         */
        result.set(
          id,
          (calendar.busy ?? [])
            .filter((slot) => slot.start && slot.end)
            .map((slot) => ({ startsAt: new Date(slot.start!), endsAt: new Date(slot.end!) })),
        );
      }
      return result;
    } catch (error) {
      throw isInvalidGrant(error)
        ? new ProviderCredentialError('google', error)
        : new ProviderUnavailableError('google', error);
    }
  }

  async createEvent(accessToken: string, booking: CalendarBooking): Promise<string> {
    const auth = this.client();
    auth.setCredentials({ access_token: accessToken });

    try {
      const response = await google.calendar({ version: 'v3', auth }).events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: eventTitle(booking),
          start: { dateTime: booking.startsAt.toISOString(), timeZone: booking.timezone },
          end: { dateTime: booking.endsAt.toISOString(), timeZone: booking.timezone },
          /*
           * D41 — INTERVIEWERS ONLY. The candidate is deliberately absent:
           * inviting them would disclose every interviewer's address, undoing
           * D20's decision to show the candidate only email local parts.
           * No description, location or conferencing either.
           */
          attendees: booking.interviewerEmails.map((email) => ({ email })),
        },
      });

      const id = response.data.id;
      if (!id) throw new ProviderUnavailableError('google', new Error('no event id returned'));
      return id;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw isInvalidGrant(error)
        ? new ProviderCredentialError('google', error)
        : new ProviderUnavailableError('google', error);
    }
  }

  async revoke(refreshToken: string): Promise<void> {
    try {
      await this.client().revokeToken(refreshToken);
    } catch (error) {
      // Best effort. The local credential is already gone; a provider that
      // refuses to revoke must not fail the disconnect the user asked for.
      this.logger.warn(`google token revocation failed: ${describe(error)}`);
    }
  }
}

/** D41 — job title plus candidate name, and nothing else. */
export function eventTitle(booking: CalendarBooking): string {
  return `Interview: ${booking.jobTitle} — ${booking.candidateName}`;
}

/** Google reports a dead grant as `invalid_grant`, in several shapes. */
function isInvalidGrant(error: unknown): boolean {
  const text = describe(error).toLowerCase();
  return text.includes('invalid_grant') || text.includes('invalid credentials');
}

/** Message text only — never the token, which may appear in a raw response. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
