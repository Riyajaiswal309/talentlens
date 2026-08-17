import type { BusyBlock, CalendarBooking } from '../../interviews/calendar.provider';

/** What a completed OAuth exchange yields (D36, D37). */
export interface AuthorisedAccount {
  /** Persisted, encrypted. The only credential that outlives the request. */
  refreshToken: string;
  /** D37 — the provider-authorised account, never assumed from users.email. */
  accountIdentifier: string;
  /** When the provider says the grant stops working, if it says at all. */
  expiresAt: Date | null;
}

/** A short-lived credential, held in memory for one operation only (D36). */
export interface AccessGrant {
  accessToken: string;
  expiresAt: Date | null;
}

/**
 * The provider is configured but did not answer — Gap 7's `503` case and
 * FR6.3's "provider unavailable".
 *
 * DISTINCT FROM "not connected". An interviewer without a calendar is a
 * reportable state (`notConnected`), not an outage; conflating them would tell
 * a recruiter the system is broken when nobody has simply linked an account.
 */
export class ProviderUnavailableError extends Error {
  constructor(provider: string, cause?: unknown) {
    super(`Calendar provider ${provider} is unavailable`);
    this.name = 'ProviderUnavailableError';
    this.cause = cause;
  }
}

/**
 * The stored credential is no longer accepted — expired, revoked at the
 * provider, or consent withdrawn.
 *
 * D36 requires this to move the connection to `disconnected` rather than
 * retrying forever, so it is a separate type from an outage: one is permanent
 * and actionable, the other is transient.
 */
export class ProviderCredentialError extends Error {
  constructor(provider: string, cause?: unknown) {
    super(`Calendar credential for ${provider} is no longer valid`);
    this.name = 'ProviderCredentialError';
    this.cause = cause;
  }
}

/**
 * One calendar provider, behind the abstraction D35 requires.
 *
 * NOTHING PROVIDER-SPECIFIC CROSSES THIS LINE. Adapters translate Google's and
 * Microsoft's very different shapes — `freebusy.query` versus `/calendar/
 * getSchedule`, `refresh_token` versus MSAL's token cache — into these six
 * methods, so the scheduling API reads identically whichever is bound.
 *
 * Adapters are stateless: every method takes the credential it needs. There is
 * no per-user adapter instance and no cached token, because a cache would be a
 * place for a credential to outlive the request that needed it.
 */
export interface ProviderAdapter {
  /** False when this deployment has no client credentials for the provider. */
  isConfigured(): boolean;

  /** Where to send the interviewer to consent. `state` is the CSRF nonce. */
  authorizationUrl(state: string): string;

  /** Exchange the one-time code for a durable grant. */
  exchangeCode(code: string): Promise<AuthorisedAccount>;

  /** Trade the stored refresh token for a short-lived access token. */
  accessToken(refreshToken: string): Promise<AccessGrant>;

  /** Busy blocks for the given provider accounts, within the window. */
  freeBusy(
    accessToken: string,
    accountIdentifiers: string[],
    window: { from: Date; to: Date },
  ): Promise<Map<string, BusyBlock[]>>;

  /** Create the interview event; returns the provider-side id. */
  createEvent(accessToken: string, booking: CalendarBooking): Promise<string>;

  /**
   * Best-effort revocation at the provider (H).
   *
   * Never throws: local invalidation has already happened by the time this
   * runs, and a provider that refuses to revoke must not fail the disconnect
   * the user asked for.
   */
  revoke(refreshToken: string): Promise<void>;
}
