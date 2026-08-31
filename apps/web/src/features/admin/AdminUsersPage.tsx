import { useId, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, SkeletonTable } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { Badge, Card, PageHeader, buttonClass } from '../../components/ui';
import { useAuth } from '../../auth/AuthContext';
import {
  ASSIGNABLE_ROLES,
  formatDateTime,
  formatRoleName,
  useAdminUsers,
  useChangeRole,
  useRevokeSessions,
  type AdminUser,
  type AssignableRole,
} from './useAdmin';

/**
 * Administrator — user management (FR8.1, FR8.4).
 *
 * `GET /v1/admin/users`, `PATCH /v1/admin/users/:id/role` and
 * `DELETE /v1/admin/users/:id/sessions` are all `@Roles(ADMIN)`. This screen is
 * gated to ADMIN in the route table as well, but that gate is a convenience —
 * the server is the boundary.
 *
 * WHAT IS DELIBERATELY ABSENT. `POST /v1/admin/users` exists and would invite a
 * user, but an invitation is delivered by email and no mail provider is
 * configured anywhere in the API (FR2.3 is blocked for the same reason). A
 * create form here would produce an account nobody could ever be told about, so
 * it is left out rather than shipped half-working.
 */
export function AdminUsersPage() {
  const [role, setRole] = useState<AssignableRole | ''>('');
  const query = useAdminUsers(role);
  const roleFilterId = useId();

  return (
    <div>
      <PageHeader
        code="ADMIN"
        title="Users"
        description="Roles and sessions for everyone in your company."
      />

      <Card className="mb-5 p-4">
        <label
          htmlFor={roleFilterId}
          className="mb-1.5 block text-xs font-semibold text-neutral-700"
        >
          Role
        </label>
        {/* Exactly the three assignable roles. CANDIDATE is not one — the
            server's `AssignableRole` omits it, so offering it would 400. */}
        <select
          id={roleFilterId}
          value={role}
          onChange={(event) => setRole(event.target.value as AssignableRole | '')}
          className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-3 text-sm text-neutral-900 transition-colors hover:border-neutral-400"
        >
          <option value="">All roles</option>
          {ASSIGNABLE_ROLES.map((value) => (
            <option key={value} value={value}>
              {formatRoleName(value)}
            </option>
          ))}
        </select>
      </Card>

      {query.isPending ? (
        <LoadingState label="Loading users…">
          <SkeletonTable rows={5} columns={4} />
        </LoadingState>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (query.data?.data.length ?? 0) === 0 ? (
        <EmptyState
          variant={role ? 'filtered' : 'empty'}
          title={role ? 'No users with that role' : 'No users'}
          description="Accounts in your company appear here."
        />
      ) : (
        <Card className="overflow-hidden" as="div">
          <ul className="divide-y divide-neutral-200">
            {query.data!.data.map((user) => (
              <li key={user.id}>
                <UserRow user={user} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {query.data?.nextCursor && (
        // Said out loud rather than silently truncated: a cursor API reports no
        // total, so "there are more" is the only true statement available.
        <p className="mt-4 text-xs text-neutral-500">More users exist beyond this page.</p>
      )}
    </div>
  );
}

function UserRow({ user }: { user: AdminUser }) {
  const { user: currentUser } = useAuth();
  const { notify } = useToast();
  const changeRole = useChangeRole(user.id);
  const revoke = useRevokeSessions(user.id);
  const selectId = useId();

  /*
   * AN ADMIN MAY NOT DEMOTE THEMSELVES. Doing so would revoke the very
   * permission needed to undo it, and could leave a company with no
   * administrator at all. The control is disabled with the reason stated —
   * the server may also refuse, but the user should not be invited to try.
   */
  const isSelf = currentUser?.email === user.email;

  function onRoleChange(next: string) {
    if (next === user.role) return;
    if (
      !window.confirm(
        `Change ${user.email} from ${formatRoleName(user.role)} to ${formatRoleName(next)}?`,
      )
    )
      return;
    changeRole.mutate(next as AssignableRole, {
      onSuccess: () => notify(`${user.email} is now ${formatRoleName(next)}.`),
    });
  }

  function onRevoke() {
    // FR8.4 is immediate and cannot be undone — §8.6 reserves a confirmed step
    // for exactly this.
    if (
      !window.confirm(
        `Revoke every active session for ${user.email}? They will be signed out immediately.`,
      )
    )
      return;
    revoke.mutate(undefined, {
      onSuccess: () => notify(`All sessions revoked for ${user.email}.`),
    });
  }

  const busy = changeRole.isPending || revoke.isPending;

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-neutral-50">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-neutral-900">{user.email}</p>
        <p className="mt-0.5 text-xs text-neutral-500">
          Joined {formatDateTime(user.createdAt)} · Last active {formatDateTime(user.lastActiveAt)}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge tone="neutral">{formatRoleName(user.role)}</Badge>
          {/* `invited` means the account has no password yet. Stated, because
              such a user cannot sign in and their sessions cannot exist. */}
          {user.invited && <Badge tone="warning">Invited — never signed in</Badge>}
          {isSelf && <Badge tone="primary">You</Badge>}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="sr-only">
          Role for {user.email}
        </label>
        <select
          id={selectId}
          value={ASSIGNABLE_ROLES.includes(user.role as AssignableRole) ? user.role : ''}
          onChange={(event) => onRoleChange(event.target.value)}
          disabled={busy || isSelf}
          aria-disabled={busy || isSelf}
          title={isSelf ? 'You cannot change your own role' : undefined}
          className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-3 text-sm text-neutral-900 disabled:opacity-40"
        >
          {/* A CANDIDATE account can be listed but not reassigned here — the
              server would refuse the value, so it is shown as unselectable. */}
          {!ASSIGNABLE_ROLES.includes(user.role as AssignableRole) && (
            <option value="">{formatRoleName(user.role)}</option>
          )}
          {ASSIGNABLE_ROLES.map((value) => (
            <option key={value} value={value}>
              {formatRoleName(value)}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={onRevoke}
          disabled={busy || user.invited}
          aria-disabled={busy || user.invited}
          title={user.invited ? 'This account has never signed in' : undefined}
          className={buttonClass('secondary')}
        >
          {revoke.isPending ? 'Revoking…' : 'Revoke sessions'}
        </button>
      </div>

      {(changeRole.error != null || revoke.error != null) && (
        <div className="w-full">
          <ErrorState
            error={changeRole.error ?? revoke.error}
            title="That change could not be applied"
          />
        </div>
      )}
    </div>
  );
}
