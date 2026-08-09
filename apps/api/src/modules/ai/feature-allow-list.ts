import { BadRequestException } from '@nestjs/common';

/**
 * BR-07 — "No protected attribute may be used as a model input feature."
 *
 * PRD §19.3 Table 19.1 fixes the model's inputs at six features and states
 * the exclusions explicitly: "name, gender, age, date of birth, address,
 * nationality, institution prestige ranking, and photograph. Institution
 * *name* is excluded because it functions as a socio-economic proxy."
 *
 * The enforcement mechanism the PRD names is "a fixed allow-list", so this
 * is a closed set: an unrecognised key is rejected rather than screened
 * against a deny-list, which would let tomorrow's proxy through.
 *
 * ON THE IDENTIFIERS: all six are printed verbatim in the Handoff Gap 2
 * `PUT /v1/jobs/:id/ranking-weights` payload, which is the same six-key
 * allow-list seen from the weighting side. M2.9 guessed two of them
 * (`education_level_match`, `certification_match_count`) and marked them
 * provisional; both were wrong, and both are corrected here.
 */
export const ALLOWED_FEATURE_KEYS = [
  'semantic_similarity',
  'skill_overlap',
  'years_experience_delta',
  'education_match',
  'recency_relevant_exp',
  'certification_match',
] as const;

export type AllowedFeatureKey = (typeof ALLOWED_FEATURE_KEYS)[number];

const ALLOWED = new Set<string>(ALLOWED_FEATURE_KEYS);

export function isAllowedFeature(key: string): key is AllowedFeatureKey {
  return ALLOWED.has(key);
}

/**
 * Reject a feature vector containing anything outside Table 19.1.
 *
 * Nothing calls this in Phase 2 — no model runs and no `match_scores` row is
 * ever written. It exists so the check is in place before the first feature
 * vector arrives, rather than being retrofitted around code that already
 * writes them.
 *
 * The error names the offending keys but not the allowed set: a caller
 * attempting to smuggle a protected attribute does not need a map of what
 * would work.
 */
export function assertAllowedFeatures(featureVector: Record<string, unknown>): void {
  const rejected = Object.keys(featureVector).filter((key) => !isAllowedFeature(key));

  if (rejected.length > 0) {
    throw new BadRequestException(
      `BR-07: feature(s) not on the PRD Table 19.1 allow-list: ${rejected.join(', ')}`,
    );
  }
}
