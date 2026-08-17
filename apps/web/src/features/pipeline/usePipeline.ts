import { useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { DEFAULT_PIPELINE_STAGES } from '@talentlens/shared-types';
import { api } from '../../lib/api-client';
import { isUuidV4, type FunnelReport } from '../analytics/useFunnel';
import type { JobCandidateListResponse } from '../candidates/useJobCandidates';

/** One column of the board. */
export interface PipelineStage {
  name: string;
  /** 1-based order from `pipeline_stages.position`. */
  position: number;
  isTerminal: boolean;
}

/**
 * The stages seeded on every job (PRD §14.1), used ONLY as a fallback.
 *
 * `Hired` and `Rejected` are the terminal pair, matching `TERMINAL_STAGES` in
 * `jobs.service.ts`. Mirrored rather than imported because the API exposes no
 * endpoint that states which of the default names are terminal.
 */
const FALLBACK_TERMINAL = new Set(['Hired', 'Rejected']);

const FALLBACK_STAGES: PipelineStage[] = DEFAULT_PIPELINE_STAGES.map((name, index) => ({
  name,
  position: index + 1,
  isTerminal: FALLBACK_TERMINAL.has(name),
}));

/**
 * The board's stage axis, from the real per-job pipeline.
 *
 * NO ENDPOINT PUBLISHES `pipeline_stages` DIRECTLY — no controller in the API
 * exposes the table. But `GET /v1/analytics/funnel?jobId=` reports along that
 * job's own axis and returns `name`, `position` and `isTerminal` for each
 * stage, even when the job has no applications at all. So the columns come from
 * live data rather than a hard-coded list.
 *
 * THE FALLBACK EXISTS FOR ONE REASON. `FunnelQueryDto` validates `jobId` with
 * `@IsUUID('4')`, and the seeded job's readable id
 * (`00000000-0000-0000-0000-000000000010`) is not a v4 — so the funnel answers
 * 400 for it. For that job only, the six §14.1 defaults stand in, and the board
 * says so on screen rather than pretending the axis was fetched.
 *
 * TODO: replace this whole hook with a real `GET /v1/jobs/:id/stages` when one
 * exists. The funnel is an analytics endpoint being read for structure, which
 * works but is not what it is for.
 */
export function usePipelineStages(jobId: string | undefined) {
  const canQuery = Boolean(jobId) && isUuidV4(jobId ?? '');

  const query = useQuery({
    queryKey: ['pipeline-stages', jobId ?? null],
    queryFn: ({ signal }) =>
      api.get<FunnelReport>('/analytics/funnel', { query: { jobId: jobId! }, signal }),
    enabled: canQuery,
  });

  const fetched = query.data?.stages;

  return {
    stages: fetched
      ? fetched.map((stage) => ({
          name: stage.name,
          position: stage.position,
          isTerminal: stage.isTerminal,
        }))
      : FALLBACK_STAGES,
    /** True when the axis is the §14.1 default rather than this job's own. */
    usingFallback: !canQuery || query.isError,
    isPending: canQuery ? query.isPending : false,
    isError: query.isError,
    error: query.error,
  };
}

/** The `ChangeStageDto` body — one field, nothing else is accepted. */
interface ChangeStageBody {
  toStage: string;
}

/** `StageChangeResponse` from `pipeline.controller.ts`. */
export interface StageChangeResponse {
  id: string;
  currentStage: string;
  /** Null on a no-op (the card was already in the target column). */
  previousStage: string | null;
  isTerminal: boolean;
  changedAt: string;
}

/**
 * `PATCH /v1/applications/:id/stage` — Recruiter and Admin (FR5.1, FR5.4).
 *
 * OPTIMISTIC, WITH A REAL ROLLBACK. Flow 7 requires the card to settle
 * immediately and to "animate back to origin" if the write fails, so the cached
 * board is edited before the request and restored from a snapshot on error. The
 * snapshot is the whole infinite-query payload rather than the single row —
 * cheaper to reason about, and it cannot leave a half-reverted board.
 *
 * A same-stage move is a no-op server-side: no history row, no audit record, no
 * candidate email. The UI does not special-case it; the response simply reports
 * `previousStage: null`.
 */
export function useChangeStage(jobId: string | undefined) {
  const queryClient = useQueryClient();
  const boardKey = ['job-candidates', jobId ?? null];

  return useMutation({
    mutationFn: ({ applicationId, toStage }: { applicationId: string; toStage: string }) =>
      api.patch<StageChangeResponse>(`/applications/${applicationId}/stage`, {
        toStage,
      } satisfies ChangeStageBody),

    onMutate: async ({ applicationId, toStage }) => {
      // Stop an in-flight refetch from overwriting the optimistic edit.
      await queryClient.cancelQueries({ queryKey: boardKey });

      const snapshot = queryClient.getQueryData<InfiniteData<JobCandidateListResponse>>(boardKey);

      queryClient.setQueryData<InfiniteData<JobCandidateListResponse>>(boardKey, (current) => {
        if (!current) return current;
        return {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            data: page.data.map((row) =>
              row.applicationId === applicationId ? { ...row, currentStage: toStage } : row,
            ),
          })),
        };
      });

      return { snapshot };
    },

    onError: (_error, _variables, context) => {
      // Flow 7's rollback. Restoring the snapshot puts the card back in its
      // origin column, and the caller surfaces the server's message.
      if (context?.snapshot) queryClient.setQueryData(boardKey, context.snapshot);
    },

    onSettled: (_data, _error, variables) => {
      /*
       * Refetch regardless of outcome — the server is the authority on where a
       * candidate is. The funnel is invalidated too because a stage change
       * moves the counts RC-12 reports, and the application detail because
       * RC-06 shows `currentStage`.
       */
      void queryClient.invalidateQueries({ queryKey: boardKey });
      void queryClient.invalidateQueries({ queryKey: ['funnel'] });
      void queryClient.invalidateQueries({ queryKey: ['application', variables.applicationId] });
    },
  });
}

/**
 * Group the board's rows into its columns.
 *
 * AN UNRECOGNISED `currentStage` IS NOT DROPPED. Stages are per-job and
 * editable (decision B2), so a card can legitimately hold a name the axis no
 * longer lists — a stage renamed after the candidate entered it. Silently
 * hiding that card would lose a real person from the board, so the extras are
 * returned separately and rendered in their own column.
 */
export function groupByStage<T extends { currentStage: string }>(
  rows: T[],
  stages: PipelineStage[],
): { columns: Map<string, T[]>; unknown: Map<string, T[]> } {
  const known = new Set(stages.map((stage) => stage.name));
  const columns = new Map<string, T[]>();
  const unknown = new Map<string, T[]>();

  for (const stage of stages) columns.set(stage.name, []);

  for (const row of rows) {
    const target = known.has(row.currentStage) ? columns : unknown;
    const bucket = target.get(row.currentStage);
    if (bucket) bucket.push(row);
    else target.set(row.currentStage, [row]);
  }

  return { columns, unknown };
}
