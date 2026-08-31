import type { RankingWeights } from '../dto/ranking-weights.dto';
import type { ScoreRationale } from '../ai-scoring.port';

/**
 * The candidate–job scoring seam (FR4.1, FR4.4).
 *
 * WHY A PORT, mirroring `ResumeParserPort`. The worker must not know whether a
 * score came from arithmetic or from a model. Today the only binding is
 * `BaselineRulesScorer`; a trained ranker replaces it by changing one line in
 * `ai.module.ts`, with no change to the worker, the schema or the UI.
 *
 * An abstract class rather than an interface: Nest needs a runtime injection
 * token.
 */

/** What the scorer needs about the job it is scoring against. */
export interface ScorableJob {
  id: string;
  requiredSkills: unknown;
  experienceLevel: string | null;
}

/**
 * What the scorer needs about the candidate.
 *
 * This is the PARSED PROFILE, which in this build carries skills and contact
 * only — FR3's rule-based parser returns work history, education and
 * certifications empty by design. The scorer is written to that reality rather
 * than to a profile it wishes it had.
 */
export interface ScorableProfile {
  skills: unknown;
  workHistory: unknown[];
  education: unknown[];
  certifications: unknown[];
}

export interface MatchScoreResult {
  /** Weighted sum, clamped to [0,1] — `match_scores_composite_score_range`. */
  composite: number;
  /**
   * The SIX allow-listed features and their computed values (FR4.4).
   *
   * Every key is present on every score, including the ones that had no data,
   * because a missing key and a zero mean different things and the stored
   * vector must be reproducible. `assertAllowedFeatures` (BR-07) is applied to
   * this by the worker before persistence.
   */
  featureVector: Record<string, number>;
  rationale: ScoreRationale;
  modelName: string;
  versionTag: string;
}

export abstract class MatchScorerPort {
  /**
   * Score one candidate against one job.
   *
   * MUST BE PURE AND DETERMINISTIC in every implementation that claims to be a
   * baseline: the same job, profile and weights must always yield the same
   * composite, or the audit trail and `featureVector` stop being reproducible,
   * which is exactly what FR4.4 exists to guarantee.
   *
   * Implementations must throw rather than return a fabricated score when they
   * cannot compute one — the worker treats a throw as "no score", and a made-up
   * number is indistinguishable from a real one once persisted.
   */
  abstract score(input: {
    job: ScorableJob;
    profile: ScorableProfile;
    weights: RankingWeights;
  }): MatchScoreResult;
}
