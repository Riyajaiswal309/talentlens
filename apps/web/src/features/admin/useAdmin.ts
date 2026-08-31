import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';

/**
 * Administrator surfaces (FR1.4, FR8.2, FR8.4).
 *
 * EVERY ROUTE HERE IS `@Roles(ADMIN)` SERVER-SIDE. The client gate in
 * `App.tsx` only keeps a Recruiter from opening a screen whose every request
 * would 403 — it is not the boundary, and nothing here assumes it is.
 */

/**
 * The roles an Administrator may assign.
 *
 * CANDIDATE is deliberately absent, mirroring `AssignableRole` on the server:
 * candidate identity is created by application submission and lives in
 * `candidates`, so offering it here would mint a login with no profile behind
 * it. Listing it would be a guaranteed 400.
 */
export const ASSIGNABLE_ROLES = ['ADMIN', 'RECRUITER', 'HIRING_MANAGER'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export interface AdminUser {
  id: string;
  email: string;
  role: string;
  /** True when the account has no password yet — invited, never signed in. */
  invited: boolean;
  createdAt: string;
  lastActiveAt: string | null;
}

interface AdminUserListResponse {
  data: AdminUser[];
  nextCursor: string | null;
}

/** §23.1 — cursor pagination, no totals. */
export const ADMIN_PAGE_SIZE = 25;

export function useAdminUsers(role: AssignableRole | '') {
  return useQuery({
    queryKey: ['admin-users', role || null],
    queryFn: ({ signal }) =>
      api.get<AdminUserListResponse>('/admin/users', {
        query: { role: role || undefined, limit: ADMIN_PAGE_SIZE },
        signal,
      }),
  });
}

/** FR8.1 — change a user's role. Body is `{ role }`; anything else is a 400. */
export function useChangeRole(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (role: AssignableRole) =>
      api.patch<AdminUser>(`/admin/users/${userId}/role`, { role }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

/**
 * FR8.4 — revoke every live session for a user, immediately.
 *
 * The server answers 204, so there is no body to read. Success is the absence
 * of an error, and the caller confirms it rather than inferring it from a
 * changed row: nothing visible on this screen changes when sessions are cut.
 */
export function useRevokeSessions(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`/admin/users/${userId}/sessions`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

export interface AiScoringResult {
  jobId: string;
  aiScoringEnabled: boolean;
}

/**
 * FR1.4 / FR8.2 / BR-04 — the per-job AI toggle, Administrator only.
 *
 * BR-04 names this route as the enforcement point, which is why the control
 * lives behind an ADMIN check on the job screen rather than in the recruiter's
 * own job form: a Recruiter must not be able to change it at all.
 */
export function useSetAiScoring(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch<AiScoringResult>(`/admin/jobs/${jobId}/ai-scoring`, { enabled }),
    onSuccess: () => {
      // The job's own record carries the flag every other screen reads.
      void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

/** `HIRING_MANAGER` is a constant, not display text. */
export function formatRoleName(role: string): string {
  return role
    .toLowerCase()
    .split('_')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
