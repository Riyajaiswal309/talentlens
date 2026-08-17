import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

/**
 * Gate for every authenticated route.
 *
 * THE SERVER IS THE REAL GUARD. `JwtAuthGuard` and `RolesGuard` run on every
 * request (§24.2), so this component decides what to *render*, never what a
 * caller may reach. Removing it would leak no data — it would only replace a
 * clean redirect with a screen full of 401s.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  // Mid-bootstrap: the refresh has not answered yet. Rendering nothing beats
  // redirecting, which would throw away a valid session on every reload.
  if (status === 'bootstrapping') return <BootstrapScreen />;

  if (status === 'unauthenticated') {
    /*
     * `replace` keeps the protected URL out of history, so Back from the login
     * page does not bounce between the two. `state.from` preserves where the
     * user was heading so sign-in can return them there.
     */
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}

/**
 * The blank moment before the session is known.
 *
 * Intentionally almost empty: it is visible for one request and a spinner that
 * flashes for 80ms reads as a glitch. The live region announces the wait to a
 * screen reader, which cannot see that the page is simply quiet (NFR4).
 */
function BootstrapScreen() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-neutral-100"
      role="status"
      aria-live="polite"
    >
      <span className="text-sm text-neutral-500">Restoring your session…</span>
    </div>
  );
}
