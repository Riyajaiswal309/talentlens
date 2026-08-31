import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';

/**
 * §24.2 — who may work a requisition (amendment B12).
 *
 * THE ELIGIBLE-USER LIST IS NOT A NEW ENDPOINT. `GET /v1/interviewers` already
 * serves a Recruiter-readable directory of the tenant's non-Candidate users,
 * and `useInterviewers()` already wraps it. It returns one role the assignment
 * API refuses — RECRUITER — so the picker narrows to the assignable pair
 * below. That narrowing is a courtesy to the user, not a control: the server
 * refuses a Recruiter or Candidate target with a 400 whatever this sends.
 */

/** Mirrors `ASSIGNABLE_ROLES` on the server. */
export const ASSIGNABLE_ROLES = ['HIRING_MANAGER', 'ADMIN'] as const;

/** Mirrors `JobAssignmentResponse`. No internal user id beyond `userId`. */
export interface JobAssignment {
  id: string;
  userId: string;
  email: string;
  role: string;
  createdAt: string;
}

export function useJobAssignments(jobId: string | undefined) {
  return useQuery({
    queryKey: ['job-assignments', jobId ?? null],
    queryFn: ({ signal }) =>
      api
        .get<{ data: JobAssignment[] }>(`/jobs/${jobId!}/assignments`, { signal })
        .then((response) => response.data),
    enabled: Boolean(jobId),
  });
}

export function useAssignToJob(jobId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api.post<JobAssignment>(`/jobs/${jobId!}/assignments`, { userId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['job-assignments', jobId] });
      /*
       * The assignee's own job list narrows through `job_assignments`, so a
       * stale `/jobs` cache would show them a job they can now open — or hide
       * one they can. Invalidated here rather than left to a refetch interval.
       */
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useUnassignFromJob(jobId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete<void>(`/jobs/${jobId!}/assignments/${userId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['job-assignments', jobId] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

/** `HIRING_MANAGER` is a stored constant, not display text. */
export function formatRole(role: string): string {
  return role
    .toLowerCase()
    .split('_')
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
