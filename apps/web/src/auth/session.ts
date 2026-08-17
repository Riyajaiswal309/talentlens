import { api, setAccessTokenProvider, setUnauthorizedRecovery } from '../lib/api-client';

/** The principal, exactly as `IdentityResponse` in `auth.controller.ts`. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  companyId: string;
}

interface SessionResponse {
  accessToken: string;
  user: AuthenticatedUser;
}

/**
 * The session, held in memory and nowhere else.
 *
 * NOT localStorage, NOT sessionStorage, NOT a readable cookie. Web storage is
 * readable by any script on the origin, so a single injected script turns a
 * 15-minute access token into a stolen credential. Durability is already
 * solved without it: the refresh token is an httpOnly cookie the JavaScript
 * context cannot read at all (§24.1), so a reload restores the session by
 * asking the server rather than by trusting something the page kept.
 *
 * The cost is one `POST /v1/auth/refresh` per page load. That is the intended
 * trade: the token that survives a reload is the one an attacker cannot read.
 */
let accessToken: string | null = null;

/**
 * The in-flight refresh, if any — the single-flight lock.
 *
 * WHY THIS EXISTS. A dashboard mounts several queries at once; when the access
 * token expires they all get 401 within a few milliseconds and all call
 * recovery. Without this every one of them would POST `/auth/refresh`, and
 * because refresh ROTATES the cookie (`auth.controller.ts` overwrites it on
 * each call), the first response invalidates the token the others are still
 * presenting — so the parallel refreshes would log the user out.
 *
 * Holding the promise means concurrent callers await the same request and all
 * receive the same new token. It is cleared in `finally` so a later expiry
 * starts a fresh attempt rather than replaying a stale result.
 */
let refreshInFlight: Promise<AuthenticatedUser | null> | null = null;

/** Notified whenever the principal changes, so React can re-render. */
type SessionListener = (user: AuthenticatedUser | null) => void;
const listeners = new Set<SessionListener>();

function publish(user: AuthenticatedUser | null): void {
  for (const listener of listeners) listener(user);
}

export function subscribeToSession(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAccessToken(): string | null {
  return accessToken;
}

function adopt(session: SessionResponse): AuthenticatedUser {
  accessToken = session.accessToken;
  publish(session.user);
  return session.user;
}

function clear(): void {
  accessToken = null;
  publish(null);
}

/**
 * Sign in (SC-01).
 *
 * `skipAuthRecovery` because a 401 here means the password was wrong, not that
 * a session expired — the caller must see that message, not a refresh attempt.
 */
export async function login(email: string, password: string): Promise<AuthenticatedUser> {
  const session = await api.post<SessionResponse>(
    '/auth/login',
    { email, password },
    { skipAuthRecovery: true },
  );
  return adopt(session);
}

/**
 * Exchange the httpOnly cookie for a new access token.
 *
 * Serves two callers with one implementation: bootstrapping a reload, and
 * recovering from a mid-session 401. Both mean the same thing — "the server
 * holds the durable credential; ask it what the session is".
 *
 * Returns null rather than throwing. Every failure — no cookie, expired
 * cookie, revoked session, API down — has the same consequence for the caller:
 * there is no session. Distinguishing them would give the UI a difference it
 * cannot act on.
 */
export function refreshSession(): Promise<AuthenticatedUser | null> {
  refreshInFlight ??= (async () => {
    try {
      const session = await api.post<SessionResponse>(
        '/auth/refresh',
        undefined,
        // Recovery IS this function. Without the skip, a 401 from refresh
        // would await the very promise it is running inside.
        { skipAuthRecovery: true },
      );
      return adopt(session);
    } catch {
      clear();
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Sign out.
 *
 * The local session is cleared even if the server call fails. A user who asked
 * to sign out must end up signed out on this device regardless of the network;
 * the server-side revocation is the part that can be retried, and the cookie
 * is cleared server-side by `res.clearCookie` when the call does land.
 */
export async function logout(): Promise<void> {
  try {
    await api.post<void>('/auth/logout', undefined, { skipAuthRecovery: true });
  } catch {
    // Deliberately swallowed — see above.
  } finally {
    clear();
  }
}

/**
 * Wire the session into the API client's seams.
 *
 * Called once at startup. Registering the provider gives every request the
 * current token, and registering recovery is what turns an expired token into
 * an invisible retry rather than a logout.
 */
export function installSessionHandlers(): void {
  setAccessTokenProvider(getAccessToken);
  setUnauthorizedRecovery(async () => {
    const user = await refreshSession();
    return user ? accessToken : null;
  });
}
