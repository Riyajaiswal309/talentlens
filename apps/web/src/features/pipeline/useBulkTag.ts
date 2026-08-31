import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';
import { MAX_TAG_LENGTH } from '../candidates/useTags';

/**
 * FR5.2 — apply one tag to several applications.
 *
 * SEPARATE FROM `useBulkStage` on purpose: a stage change moves candidates and
 * must invalidate the board, whereas a tag changes nothing the board renders.
 * Sharing one hook would force a board refetch for an action that cannot alter
 * it.
 */
export interface BulkTagResult {
  label: string;
  tagged: string[];
  /** Already carried this tag — a no-op, not a failure and not a write. */
  alreadyTagged: string[];
  failed: { id: string; reason: string }[];
}

export { MAX_TAG_LENGTH };

export function useBulkTag() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ applicationIds, label }: { applicationIds: string[]; label: string }) =>
      api.post<BulkTagResult>('/applications/bulk/tags', { applicationIds, label }),
    onSuccess: () => {
      // Any open candidate-detail tag list is now stale.
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
    },
  });
}
