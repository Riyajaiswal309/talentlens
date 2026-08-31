import { Injectable, Logger } from '@nestjs/common';
import { ALLOWED_FEATURE_KEYS } from '../feature-allow-list';
import type { RankingWeights } from '../dto/ranking-weights.dto';
import type { ScoreRationale, ScoreRationaleFactor } from '../ai-scoring.port';
import {
  MatchScorerPort,
  type MatchScoreResult,
  type ScorableJob,
  type ScorableProfile,
} from './match-scorer.port';

/**
 * `baseline-rules-v1` — a transparent, deterministic candidate–job scorer
 * (FR4.1, FR4.4).
 *
 * THIS IS NOT A MODEL. It is a weighted sum of six numbers, every one of which
 * is derived by a rule stated below. Nothing is trained, nothing is learned,
 * and the version tag says `baseline-rules-v1` precisely so it can never be
 * mistaken for §19's ranker in an audit row or on screen.
 *
 * ONLY ONE OF THE SIX FEATURES HAS DATA IN THIS BUILD, and that is the single
 * most important thing to understand about it. FR3's parser extracts contact
 * details and skills; it returns work history, education and certifications
 * empty by design. So:
 *
 *   skill_overlap          — REAL. Required skills matched against extracted.
 *   semantic_similarity    — 0. No embeddings exist, and the parsed profile
 *                            carries no document text to compare.
 *   years_experience_delta — 0. No work history is extracted.
 *   recency_relevant_exp   — 0. Same.
 *   education_match        — 0. No education is extracted.
 *   certification_match    — 0. No certifications are extracted.
 *
 * A zero here means "no evidence available", NOT "the candidate lacks this".
 * The rationale says so in words, every time, because a recruiter reading a
 * composite of 0.24 must not conclude the candidate is weak when the truth is
 * that five of six inputs were never measured.
 *
 * WHY THE COMPOSITE IS NOT RE-NORMALISED over the features that do have data:
 * dividing by the available weight would inflate a skills-only match to look
 * like a fully-evidenced one. A candidate assessed on one sixth of the criteria
 * should score like a candidate assessed on one sixth of the criteria. The
 * ceiling that implies is stated in the rationale rather than engineered away.
 */
@Injectable()
export class BaselineRulesScorer extends MatchScorerPort {
  private readonly logger = new Logger(BaselineRulesScorer.name);

  static readonly MODEL_NAME = 'baseline-rules';
  static readonly VERSION_TAG = 'baseline-rules-v1';

  /**
   * Features this build cannot measure, with the reason. Kept as data so the
   * rationale, the logs and any future test all read the same list.
   */
  private static readonly UNAVAILABLE: Record<string, string> = {
    semantic_similarity:
      'no embeddings are computed and the parsed profile carries no document text',
    years_experience_delta: 'work history is not extracted by the rule-based parser',
    recency_relevant_exp: 'work history is not extracted by the rule-based parser',
    education_match: 'education is not extracted by the rule-based parser',
    certification_match: 'certifications are not extracted by the rule-based parser',
  };

  score({
    job,
    profile,
    weights,
  }: {
    job: ScorableJob;
    profile: ScorableProfile;
    weights: RankingWeights;
  }): MatchScoreResult {
    const required = toStringList(job.requiredSkills);
    const candidate = toStringList(profile.skills);

    /*
     * skill_overlap — the proportion of the job's REQUIRED skills the candidate
     * demonstrably has. Denominator is the requirement, not the candidate's
     * list, so padding a CV with unrelated skills cannot raise the score.
     *
     * Case-insensitive exact match on the whole term. The parser produces
     * canonical vocabulary entries, so no fuzzy matching is needed and none is
     * done — fuzzy matching here would silently equate "Java" with
     * "JavaScript".
     */
    const wanted = new Set(required.map((s) => s.toLowerCase()));
    const held = new Set(candidate.map((s) => s.toLowerCase()));
    const matched = [...wanted].filter((skill) => held.has(skill));
    const skillOverlap = wanted.size === 0 ? 0 : round4(matched.length / wanted.size);

    // Every allow-listed key is present, so the stored vector is complete and
    // reproducible (FR4.4). Unmeasured features are an explicit 0.
    const featureVector: Record<string, number> = {
      semantic_similarity: 0,
      skill_overlap: skillOverlap,
      years_experience_delta: 0,
      education_match: 0,
      recency_relevant_exp: 0,
      certification_match: 0,
    };

    // The composite: a plain weighted sum over the six allow-listed features.
    let composite = 0;
    for (const key of ALLOWED_FEATURE_KEYS) {
      composite += (weights[key] ?? 0) * (featureVector[key] ?? 0);
    }
    // Clamped to satisfy `match_scores_composite_score_range` even if a caller
    // supplies weights that do not sum to 1.
    composite = round4(Math.min(1, Math.max(0, composite)));

    const rationale = this.explain({
      composite,
      featureVector,
      weights,
      required,
      matched,
      wanted,
    });

    this.logger.debug(
      `scored job=${job.id} skills=${matched.length}/${wanted.size} composite=${composite}`,
    );

    return {
      composite,
      featureVector,
      rationale,
      modelName: BaselineRulesScorer.MODEL_NAME,
      versionTag: BaselineRulesScorer.VERSION_TAG,
    };
  }

  /**
   * BR-02 — the rationale, derived from the SAME numbers that produced the
   * composite. Nothing here is written by hand or generated separately; each
   * factor's `contribution` is literally `weight × feature`, so the summary and
   * the score cannot disagree.
   */
  private explain({
    composite,
    featureVector,
    weights,
    required,
    matched,
    wanted,
  }: {
    composite: number;
    featureVector: Record<string, number>;
    weights: RankingWeights;
    required: string[];
    matched: string[];
    wanted: Set<string>;
  }): ScoreRationale {
    const factors: ScoreRationaleFactor[] = ALLOWED_FEATURE_KEYS.map((key) => ({
      feature: key,
      contribution: round4((weights[key] ?? 0) * (featureVector[key] ?? 0)),
      // Nothing in this scorer can push a score DOWN — every feature is a
      // non-negative contribution — so a zero contribution is reported as
      // positive-with-no-effect rather than as evidence against the candidate.
      direction: 'positive' as const,
    })).sort((a, b) => b.contribution - a.contribution);

    const unmeasured = Object.keys(BaselineRulesScorer.UNAVAILABLE);
    // The highest composite this build could produce for a perfect candidate.
    const ceiling = round4(weights.skill_overlap ?? 0);

    const skillSentence =
      wanted.size === 0
        ? 'This job lists no required skills, so no skills comparison was possible.'
        : `Matched ${matched.length} of ${wanted.size} required skills` +
          (matched.length > 0
            ? ` (${required.filter((s) => matched.includes(s.toLowerCase())).join(', ')}).`
            : '.');

    const summary =
      `Score ${composite.toFixed(2)} from baseline-rules-v1, a deterministic weighted sum — not a trained model. ` +
      `${skillSentence} ` +
      `${unmeasured.length} of the 6 ranking features could not be measured in this build ` +
      `(${unmeasured.join(', ')}), so they contributed 0. A zero here means no evidence was available, ` +
      `not that the candidate lacks it. With only skills measurable, the highest attainable score is ` +
      `${ceiling.toFixed(2)}; treat this as a skills-match indicator, not an overall assessment.`;

    return { summary, factors };
  }
}

/** Tolerates a jsonb column that may hold anything. */
function toStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

/** `composite_score` is DECIMAL(5,4); rounding here keeps stored == computed. */
function round4(value: number): number {
  return Number(value.toFixed(4));
}
