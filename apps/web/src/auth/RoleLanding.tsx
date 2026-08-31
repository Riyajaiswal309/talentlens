import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

/**
 * Where an unknown path sends a signed-in user.
 *
 * ROLE-AWARE, because there is no single landing screen any more. RC-01 reads
 * `GET /v1/analytics/funnel`, which is Recruiter and Admin only, so forwarding
 * a Hiring Manager to `/dashboard` would answer a mistyped URL with a 403 —
 * the workspace telling them they do not belong in it. Their equivalent
 * landing is the review queue.
 *
 * This component sits INSIDE the auth guards, so a signed-out visitor never
 * reaches it: `RequireAuth` has already sent them to /login. It therefore only
 * ever chooses between two destinations the user can actually open, and the
 * redirect itself grants nothing — both targets re-check the role.
 */
export function RoleLanding() {
  const { user } = useAuth();

  return <Navigate to={user?.role === 'HIRING_MANAGER' ? '/my-reviews' : '/dashboard'} replace />;
}
