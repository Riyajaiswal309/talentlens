import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';
import type { JobResponse, JobStatus } from './useJobs';

/**
 * The writable fields of a job — `CreateJobDto` exactly.
 *
 * NO `status`, DELIBERATELY. `CreateJobDto` has no status field, so a job is
 * always born DRAFT (`jobs.service.ts` relies on the column default and seeds
 * the six pipeline stages in the same transaction). Publishing is a separate
 * PATCH, which is also how Phase 1 Flow 1 sequences it: step 5 saves, step 6
 * publishes behind a confirmation.
 *
 * NO `aiScoringEnabled` either: BR-04 reserves it for an Administrator, and
 * `UpdateJobDto` does not accept it.
 */
export interface JobInput {
  title: string;
  department?: string;
  location?: string;
  employmentType?: string;
  experienceLevel?: string;
  description?: string;
  requiredSkills?: string[];
}

/** `UpdateJobDto` = PartialType(CreateJobDto) + optional status. */
export type JobPatch = Partial<JobInput> & { status?: JobStatus };

/**
 * The status changes the API will accept, from `ALLOWED_TRANSITIONS`.
 *
 * MIRRORED, NOT GUESSED. `jobs.service.ts` refuses anything else with a 409:
 * PUBLISHED → DRAFT is absent from the PRD ("a job that has been publicly
 * visible cannot quietly become a draft again") and CLOSED is terminal because
 * no document describes reopening one.
 *
 * The UI offers only these, so a recruiter is never shown a control whose only
 * possible outcome is an error.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  DRAFT: ['PUBLISHED', 'CLOSED'],
  PUBLISHED: ['CLOSED'],
  CLOSED: [],
};

/** POST /v1/jobs — Recruiter, Admin. Returns 201 with the created job. */
export function useCreateJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: JobInput) => api.post<JobResponse>('/jobs', input),
    onSuccess: (job) => {
      /*
       * Every cached list is now stale, and the filters/cursor of each are
       * unknown here — so the whole `jobs` key is invalidated rather than
       * trying to splice the new row into one page. Seeding `['job', id]` from
       * the response means RC-04 renders immediately on arrival instead of
       * showing its skeleton for a round trip it does not need.
       */
      queryClient.setQueryData(['job', job.id], job);
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

/**
 * FR1.3 — "Recruiters can duplicate an existing posting as a template."
 *
 * `POST /v1/jobs/:id/duplicate`. The copy comes back as a DRAFT with its own
 * id, which is why the caller navigates to it rather than staying put: the
 * user's next act is always to edit the copy, and leaving them on the original
 * would make a successful duplicate look like nothing happened.
 */
export function useDuplicateJob(jobId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<JobResponse>(`/jobs/${jobId!}/duplicate`),
    onSuccess: (job) => {
      // Same reasoning as `useCreateJob`: seed the new record, invalidate lists.
      queryClient.setQueryData(['job', job.id], job);
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

/** PATCH /v1/jobs/:id — edit, publish or close. Recruiter, Admin. */
export function useUpdateJob(jobId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patch: JobPatch) => api.patch<JobResponse>(`/jobs/${jobId!}`, patch),
    onSuccess: (job) => {
      queryClient.setQueryData(['job', job.id], job);
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}
