import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';
import { isUuidV4 } from '../analytics/useFunnel';

/** `MAX_BULK_APPLICATIONS` in `bulk-change-stage.dto.ts`. */
export const MAX_BULK_APPLICATIONS = 100;

/**
 * `BulkStageResponse` from `pipeline.controller.ts`.
 *
 * ALWAYS 200, EVEN WHEN EVERY ITEM FAILED. The request itself was understood;
 * the outcome per candidate is the payload. So this is never an error response
 * to be caught — it is a result to be read, and the UI must render both lists.
 *
 * `succeeded` also contains candidates who were ALREADY in the target stage:
 * the caller asked for an end state and it holds. Those produced no history row
 * and no audit record, because nothing moved.
 */
export interface BulkStageResponse {
  succeeded: string[];
  failed: { id: string; reason: string }[];
}

/**
 * `PATCH /v1/applications/bulk/stage` — Recruiter, Admin (FR5.2, RC-10).
 *
 * NOT OPTIMISTIC, unlike the single-card move. A bulk call can partially
 * succeed, so an optimistic board would have to be half-rolled-back from the
 * `failed` list — and a card that flickered into a column and back is worse
 * than one that waits. The bar shows a pending state and the board refetches
 * once the real outcome is known.
 *
 * The server deduplicates ids and caps the batch at 100; both are mirrored in
 * the caller so a request that cannot succeed is never sent.
 */
export function useBulkStage(jobId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ applicationIds, toStage }: { applicationIds: string[]; toStage: string }) =>
      api.patch<BulkStageResponse>('/applications/bulk/stage', { applicationIds, toStage }),

    onSettled: () => {
      /*
       * Refetch regardless of outcome — with a partial result the server is the
       * only authority on which cards moved. The funnel is invalidated too
       * because the counts RC-12 and RC-01 report have changed.
       */
      void queryClient.invalidateQueries({ queryKey: ['job-candidates', jobId ?? null] });
      void queryClient.invalidateQueries({ queryKey: ['funnel'] });
    },
  });
}

/**
 * Which of the selected ids the endpoint will actually accept.
 *
 * `BulkChangeStageDto` validates `@IsUUID('4', { each: true })`, so a single
 * non-v4 id makes the WHOLE batch a 400 — every other candidate in the
 * selection would fail with it. Splitting them out first means one bad id costs
 * only itself, and the caller can say so instead of showing a validation error
 * that names nothing the recruiter chose.
 */
export function partitionSelectable(ids: string[]): { sendable: string[]; rejected: string[] } {
  const sendable: string[] = [];
  const rejected: string[] = [];
  for (const id of ids) (isUuidV4(id) ? sendable : rejected).push(id);
  return { sendable, rejected };
}
