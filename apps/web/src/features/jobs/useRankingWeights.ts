import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';

/**
 * The six features of PRD §19.3 Table 19.1, in the order the API declares them.
 *
 * A CLOSED ALLOW-LIST, NOT A SUGGESTION. `feature-allow-list.ts` calls this the
 * enforcement point for BR-07 — "no protected attribute may be used as a model
 * input feature" — and `RankingWeightValues` declares the six as fixed
 * properties so `forbidNonWhitelisted` rejects anything else before a handler
 * runs. The UI therefore renders exactly these keys and offers no way to add
 * one; a seventh field would be rejected, and rightly.
 */
export const FEATURE_KEYS = [
  'semantic_similarity',
  'skill_overlap',
  'years_experience_delta',
  'education_match',
  'recency_relevant_exp',
  'certification_match',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type RankingWeights = Record<FeatureKey, number>;

/** Human labels. The keys are stored identifiers, not display text. */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  semantic_similarity: 'Semantic similarity',
  skill_overlap: 'Skill overlap',
  years_experience_delta: 'Years of experience',
  education_match: 'Education match',
  recency_relevant_exp: 'Recent relevant experience',
  certification_match: 'Certification match',
};

/**
 * `WEIGHT_SUM_TOLERANCE` from `ranking-weights.dto.ts` (Gap 2 rule 3).
 *
 * The service rejects anything outside 1.0 ± 0.001 with
 * `"Weights must sum to 1.0 (received X)"`. Mirrored so the total can be shown
 * live and a save that cannot succeed is never sent.
 */
export const WEIGHT_SUM_TOLERANCE = 0.001;
export const MIN_WEIGHT = 0;
export const MAX_WEIGHT = 1;

export interface WeightsView {
  weights: RankingWeights;
  /** True when the job has never been weighted — these are the documented defaults. */
  isDefault: boolean;
  updatedAt: string | null;
}

/**
 * The PUT response. Deliberately NARROWER than the GET view — the controller
 * returns only these three fields, so `isDefault` and `updatedAt` are refetched
 * rather than inferred.
 */
export interface WeightsWriteResult {
  weights: RankingWeights;
  /** Applications on this job — the pool a re-score would cover. */
  affectedApplicationCount: number;
  /**
   * `'queued'` only when the job has AI scoring enabled; `'not_applicable'`
   * otherwise. Reported verbatim — the UI must not translate
   * `not_applicable` into a claim that anything was scored.
   */
  rescoreStatus: string;
}

export function useRankingWeights(jobId: string | undefined) {
  return useQuery({
    queryKey: ['ranking-weights', jobId ?? null],
    queryFn: ({ signal }) => api.get<WeightsView>(`/jobs/${jobId!}/ranking-weights`, { signal }),
    enabled: Boolean(jobId),
  });
}

/**
 * `PUT /v1/jobs/:id/ranking-weights` — Recruiter, Admin (FR4.2, BR-07).
 *
 * Audited as `job.ranking_weights_changed`, with the previous weighting in the
 * before-state, so a tuning decision is reconstructable.
 *
 * A CLOSED JOB IS REFUSED with 409 `"Ranking weights cannot be changed on a
 * closed job"` — the GET still answers with the stored or default values, so
 * the screen can show them read-only.
 */
export function useSetRankingWeights(jobId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (weights: RankingWeights) =>
      api.put<WeightsWriteResult>(`/jobs/${jobId!}/ranking-weights`, { weights }),
    onSuccess: () => {
      // Refetch rather than patch the cache: `isDefault` and `updatedAt` are
      // not in the write response, and the server owns both.
      void queryClient.invalidateQueries({ queryKey: ['ranking-weights', jobId ?? null] });
    },
  });
}

/** Sum to four decimals, matching how the server reports a rejected total. */
export function weightSum(weights: RankingWeights): number {
  return Number(
    Object.values(weights)
      .reduce((total, value) => total + value, 0)
      .toFixed(4),
  );
}

export function sumIsValid(weights: RankingWeights): boolean {
  return Math.abs(weightSum(weights) - 1) <= WEIGHT_SUM_TOLERANCE;
}
