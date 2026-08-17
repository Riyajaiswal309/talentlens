import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  installSessionHandlers,
  login as sessionLogin,
  logout as sessionLogout,
  refreshSession,
  subscribeToSession,
  type AuthenticatedUser,
} from './session';

/**
 * Where the app is in working out who the user is.
 *
 * `bootstrapping` IS NOT `unauthenticated`, and conflating them is the bug
 * this state exists to prevent: on every reload there is a moment before
 * `/auth/refresh` answers, and a guard that treated it as signed-out would
 * bounce a perfectly valid session to the login page on each refresh.
 */
export type AuthStatus = 'bootstrapping' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthenticatedUser | null;
  signIn: (email: string, password: string) => Promise<AuthenticatedUser>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Registered at module scope so it is in place before any component mounts and
// cannot be run twice by React 18's development double-mount.
installSessionHandlers();

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('bootstrapping');

  /*
   * The session store is the single source of truth, and it changes from
   * outside React too — a silent refresh triggered by any API call updates the
   * principal without a component asking. Subscribing keeps this state honest
   * instead of letting it drift from the token actually being sent.
   */
  useEffect(() => subscribeToSession(setUser), []);

  /*
   * RESTORE ON RELOAD. The access token died with the previous page; the
   * httpOnly cookie did not. One refresh on mount is what turns a reload back
   * into a session — and its failure is the normal path for a visitor who has
   * never signed in, so it is not an error.
   */
  useEffect(() => {
    let cancelled = false;
    void refreshSession().then((restored) => {
      if (cancelled) return;
      setStatus(restored ? 'authenticated' : 'unauthenticated');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const authenticated = await sessionLogin(email, password);
    setStatus('authenticated');
    return authenticated;
  }, []);

  const signOut = useCallback(async () => {
    await sessionLogout();
    setStatus('unauthenticated');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, signIn, signOut }),
    [status, user, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
