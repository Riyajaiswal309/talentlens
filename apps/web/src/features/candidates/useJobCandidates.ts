import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../../lib/api-client';

/**
 * `WireScore` from `apps/api/src/modules/ai/score-view.ts`.
 *
 * NULL IS THE PHASE 2 VALUE, NOT A GAP. `toWireScore` returns null for every
 * `NotScored` result, and the null provider answers `NotScored` always — so a
 * row's `score` is null on every job today. FR4.5 calls that a rendering, not
 * a failure, which is why the UI removes the score columns rather than showing
 * an empty one.
 *
 * BR-02 is structural: `rationale` is required on this type, so a score can
 * never arrive without the explanation for it.
 */
export interface WireScore {
  composite: number;
  modelVersion: string;
  rationale: {
    summary: string;
    factors: { feature: string; contribution: number; direction: string }[];
  };
  overridden: boolean;
}

/** `JobCandidateResponse` from `job-candidates.controller.ts`. */
export interface JobCandidateResponse {
  /** The APPLICATION id — one person's application to this job. */
  applicationId: string;
  candidate: {
    fullName: string;
    email: string;
  };
  currentStage: string;
  appliedAt: string;
  /** FR2.5 — always `PENDING` in Phase 2; no parser runs. */
  parseStatus: string | null;
  score: WireScore | null;
}

export interface JobCandidateListResponse {
  data: JobCandidateResponse[];
  nextCursor: string | null;
}

/**
 * RC-05's page size. The DTO caps it at 100; §7.2 draws eight skeleton rows,
 * and a page a recruiter can scan without scrolling twice is the point.
 */
export const CANDIDATE_PAGE_SIZE = 20;

/**
 * `GET /v1/jobs/:id/candidates` — cursor-paginated, accumulating.
 *
 * `useInfiniteQuery` rather than the page-at-a-time hook RC-02 uses, because
 * §7.2 specifies "Load more", not numbered pages: a recruiter scanning a
 * shortlist wants one growing list, not to lose their place by paging.
 *
 * NO FILTER PARAMETERS ARE SENT. Table 5.1 sketches a filter bar, but
 * `ListJobCandidatesQueryDto` accepts only `cursor` and `limit` and the global
 * ValidationPipe runs with `forbidNonWhitelisted` — so any filter this client
 * invented would come back 400, not silently ignored. The DTO says as much in
 * its own comment: the parameter names were never specified.
 */
export function useJobCandidates(jobId: string | undefined) {
  return useInfiniteQuery({
    queryKey: ['job-candidates', jobId ?? null],
    queryFn: ({ pageParam, signal }) =>
      api.get<JobCandidateListResponse>(`/jobs/${jobId!}/candidates`, {
        query: { cursor: pageParam, limit: CANDIDATE_PAGE_SIZE },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    // null means "no further page"; undefined is what disables the button.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(jobId),
  });
}

/**
 * `Applied` / `PENDING_SELECTION` are constants, not display text.
 *
 * Stage names come from `pipeline_stages`, which decision B2 makes per-job and
 * user-editable, so they are shown as stored with only casing normalised —
 * mapping them to a fixed vocabulary would rename a recruiter's own stage.
 */
export function formatStage(stage: string): string {
  if (!stage) return '';
  return stage
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^(.)/, (character) => character.toUpperCase());
}
