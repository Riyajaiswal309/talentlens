import { Outlet } from 'react-router-dom';
import { USER_ROLES, type UserRole } from '@talentlens/shared-types';
import { useAuth } from './AuthContext';

/**
 * The roles the recruiter application is built for (PRD §24.2, Phase 1 §4.1).
 *
 * Administrators are included because Table 5.1 lists them on RC-01 through
 * RC-05 alongside Recruiters. Hiring Managers are NOT: §8.2 requires that
 * persona never learn pipeline mechanics, and their surfaces are the separate
 * HM-01…HM-05 screens. Candidates have no recruiter surface at all (BR-06).
 */
export const RECRUITER_APP_ROLES: readonly UserRole[] = ['RECRUITER', 'ADMIN'];

function isKnownRole(role: string): role is UserRole {
  return (USER_ROLES as readonly string[]).includes(role);
}

/**
 * Gate for role-restricted routes. Nest inside `RequireAuth`, which has
 * already established that there is a principal.
 */
export function RequireRole({ allow = RECRUITER_APP_ROLES }: { allow?: readonly UserRole[] }) {
  const { user } = useAuth();

  /*
   * NOT A REDIRECT TO /login. This user IS signed in — their role simply does
   * not include this surface, and bouncing them to a login form would invite
   * them to fix it by signing in again, which cannot work. Phase 1 SY-01 wants
   * the problem named and a way out, so the screen says so and offers sign-out.
   */
  if (!user || !isKnownRole(user.role) || !allow.includes(user.role)) {
    return <ForbiddenScreen role={user?.role} />;
  }

  return <Outlet />;
}

function ForbiddenScreen({ role }: { role?: string }) {
  const { signOut } = useAuth();

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-100 p-6">
      <div className="w-full max-w-md rounded-md border border-neutral-300 bg-neutral-0 p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-neutral-900">
          This area is not available to you
        </h1>
        <p className="mt-2 text-sm text-neutral-700">
          The recruiter workspace is open to Recruiters and Administrators.
          {role ? ` You are signed in as ${role.replace('_', ' ').toLowerCase()}.` : ''}
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-6 h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100"
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
