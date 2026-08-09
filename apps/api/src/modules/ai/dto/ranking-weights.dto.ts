import { IsNumber, IsObject, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ALLOWED_FEATURE_KEYS } from '../feature-allow-list';

/** Gap 2 rule 3 — values must sum to 1.0 within this tolerance. */
export const WEIGHT_SUM_TOLERANCE = 0.001;

/**
 * The six PRD Table 19.1 features, each in [0, 1].
 *
 * Declared as explicit properties rather than a free-form record so
 * `forbidNonWhitelisted` rejects an unknown key before any handler runs —
 * Gap 2 rule 1 calls this "the enforcement point for 'no protected attribute
 * may be used as a model input'" (BR-07), and a validator that had to be
 * remembered would be a weaker one.
 */
export class RankingWeightValues {
  @IsNumber() @Min(0) @Max(1) semantic_similarity!: number;
  @IsNumber() @Min(0) @Max(1) skill_overlap!: number;
  @IsNumber() @Min(0) @Max(1) years_experience_delta!: number;
  @IsNumber() @Min(0) @Max(1) education_match!: number;
  @IsNumber() @Min(0) @Max(1) recency_relevant_exp!: number;
  @IsNumber() @Min(0) @Max(1) certification_match!: number;
}

export class SetRankingWeightsDto {
  @IsObject()
  @ValidateNested()
  @Type(() => RankingWeightValues)
  weights!: RankingWeightValues;
}

export type RankingWeights = Record<(typeof ALLOWED_FEATURE_KEYS)[number], number>;

/**
 * The default weighting, from the Handoff Gap 2 sample payload.
 *
 * Returned with `isDefault: true` when a job has never been weighted. These
 * are the documented starting values, not a tuned configuration — no model
 * has been trained, so nothing has been tuned.
 */
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  semantic_similarity: 0.3,
  skill_overlap: 0.3,
  years_experience_delta: 0.15,
  education_match: 0.1,
  recency_relevant_exp: 0.1,
  certification_match: 0.05,
};
