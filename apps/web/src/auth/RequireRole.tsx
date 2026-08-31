import { Link, Outlet } from 'react-router-dom';
import { USER_ROLES, type UserRole } from '@talentlens/shared-types';
import { LogoMark } from '../components/icons';
import { buttonClass } from '../components/ui';
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
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-6">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-neutral-0 p-6 shadow-lg">
        <Link to="/" className="inline-flex items-center gap-2.5 rounded-sm">
          <LogoMark className="h-8 w-8" />
          <span className="text-base font-semibold text-neutral-900">TalentLens</span>
        </Link>

        <h1 className="mt-6 text-xl font-semibold text-neutral-900">
          This area is not available to you
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-neutral-500">
          The recruiter workspace is open to Recruiters and Administrators.
          {role ? ` You are signed in as ${role.replace('_', ' ').toLowerCase()}.` : ''}
        </p>

        {/*
          TWO WAYS OUT, not one. Signing out is the right move for someone on
          the wrong account, but a Hiring Manager on their OWN account should
          not have to destroy a valid session to leave a page they mis-clicked.
        */}
        <div className="mt-6 flex flex-wrap gap-2">
          <Link to="/" className={buttonClass('secondary')}>
            Back to home
          </Link>
          <button type="button" onClick={() => void signOut()} className={buttonClass('ghost')}>
            Sign out
          </button>
        </div>
      </div>
    </main>
  );
}
