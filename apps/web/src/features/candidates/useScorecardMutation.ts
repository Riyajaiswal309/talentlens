import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';
import { isApiError } from '../../lib/problem-details';
import type { ScorecardResponse } from './useApplication';

/**
 * Bounds from `create-scorecard.dto.ts`.
 *
 * The 1–5 scale was approved on 9 Aug 2026 because Phase 1 HM-04 says "rating
 * scale" without stating one. Mirrored here so an out-of-range value never
 * becomes a round trip, and exported so the list and the form cannot drift
 * apart about what the scale is.
 */
export const MIN_RATING = 1;
export const MAX_RATING = 5;
export const MAX_FEEDBACK_LENGTH = 5000;

/** The `CreateScorecardDto` body. `forbidNonWhitelisted` rejects anything else. */
export interface ScorecardInput {
  rating: number;
  /** Optional: `scorecards.feedback` is nullable — a rating alone is valid. */
  feedback?: string;
}

/**
 * `POST /v1/applications/:id/scorecards` (FR5.3) — Recruiter, Hiring Manager,
 * Admin. Returns 201 with the created scorecard.
 *
 * ONE SCORECARD PER AUTHOR, enforced by a unique constraint in the database
 * rather than by a read-then-write check — so a duplicate arrives as a 409
 * (`"You have already submitted a scorecard for this candidate"`) and the two
 * concurrent submissions that would race a pre-check cannot both win.
 *
 * THE 409 REFRESHES THE LIST TOO. If this author already has a scorecard, the
 * one they are looking at is out of date — invalidating on the conflict makes
 * their existing entry appear beside the message, which is more useful than the
 * error alone.
 */
export function useAddScorecard(applicationId: string | undefined) {
  const queryClient = useQueryClient();
  const listKey = ['application-scorecards', applicationId ?? null];

  return useMutation({
    mutationFn: (input: ScorecardInput) =>
      api.post<ScorecardResponse>(`/applications/${applicationId!}/scorecards`, input),

    onSuccess: () => {
      /*
       * Invalidate rather than append: the server assigns the id, the author
       * and the timestamp, and a refetch is the only way the list also reflects
       * anything a colleague submitted in the meantime.
       */
      void queryClient.invalidateQueries({ queryKey: listKey });
    },

    onError: (error) => {
      if (isApiError(error) && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: listKey });
      }
    },
  });
}
