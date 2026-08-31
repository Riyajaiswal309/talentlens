import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';

/**
 * FR5.2 — application tags.
 *
 * HIRING-TEAM ONLY. Every route here is `@Roles(RECRUITER, HIRING_MANAGER,
 * ADMIN)`; a Candidate cannot reach them at all. The recruiter console is
 * already gated to Recruiter and Admin, so this hook is never mounted for
 * anyone who would be refused.
 */

/** Mirrors `MAX_TAG_LENGTH` on the server; anything longer is a 400. */
export const MAX_TAG_LENGTH = 40;

export interface Tag {
  id: string;
  label: string;
  createdAt: string;
  /** Denormalised on the server — no internal user id is exposed. */
  createdByEmail: string;
}

export function useTags(applicationId: string | undefined) {
  return useQuery({
    queryKey: ['tags', applicationId ?? null],
    queryFn: ({ signal }) =>
      api.get<{ data: Tag[] }>(`/applications/${applicationId!}/tags`, { signal }),
    enabled: Boolean(applicationId),
  });
}

export function useAddTag(applicationId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => api.post<Tag>(`/applications/${applicationId!}/tags`, { label }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tags', applicationId] }),
  });
}

export function useRemoveTag(applicationId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tagId: string) =>
      api.delete<void>(`/applications/${applicationId!}/tags/${tagId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tags', applicationId] }),
  });
}
