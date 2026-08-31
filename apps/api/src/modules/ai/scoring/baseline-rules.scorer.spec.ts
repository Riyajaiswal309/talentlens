import { BaselineRulesScorer } from './baseline-rules.scorer';
import { DEFAULT_RANKING_WEIGHTS, type RankingWeights } from '../dto/ranking-weights.dto';
import { ALLOWED_FEATURE_KEYS, assertAllowedFeatures } from '../feature-allow-list';
import type { ScorableJob, ScorableProfile } from './match-scorer.port';

/**
 * `baseline-rules-v1` (FR4.1, FR4.4).
 *
 * PURE ARITHMETIC, so these are pure unit tests — no database, no Nest module,
 * no network. That is the point of the scorer being deterministic: every
 * expectation below is a number that can be worked out by hand from the
 * weights, which is what makes the stored `feature_vector` reproducible.
 */
describe('BaselineRulesScorer', () => {
  const scorer = new BaselineRulesScorer();

  const job = (requiredSkills: unknown): ScorableJob => ({
    id: 'job-1',
    requiredSkills,
    experienceLevel: 'Mid',
  });

  const profile = (skills: unknown): ScorableProfile => ({
    skills,
    workHistory: [],
    education: [],
    certifications: [],
  });

  const run = (
    required: unknown,
    held: unknown,
    weights: RankingWeights = DEFAULT_RANKING_WEIGHTS,
  ) => scorer.score({ job: job(required), profile: profile(held), weights });

  describe('the composite', () => {
    it('is weight x skill_overlap when skills are the only measurable feature', () => {
      // 2 of 4 required skills → skill_overlap 0.5; default weight 0.3.
      const result = run(['TypeScript', 'React', 'AWS', 'Kafka'], ['TypeScript', 'React']);

      expect(result.featureVector.skill_overlap).toBe(0.5);
      expect(result.composite).toBe(0.15); // 0.3 * 0.5
    });

    it('reaches the weight ceiling on a perfect skills match, not 1.0', () => {
      /*
       * The honest consequence of five unmeasurable features: even a candidate
       * with every required skill cannot exceed skill_overlap's own weight.
       * Re-normalising to reach 1.0 would misrepresent one sixth of an
       * assessment as a complete one.
       */
      const result = run(['Python', 'Django'], ['Python', 'Django', 'Docker']);

      expect(result.featureVector.skill_overlap).toBe(1);
      expect(result.composite).toBe(DEFAULT_RANKING_WEIGHTS.skill_overlap);
      expect(result.composite).toBe(0.3);
    });

    it('is 0 when nothing matches', () => {
      expect(run(['Rust', 'Go'], ['PHP']).composite).toBe(0);
    });

    it('divides by the REQUIREMENT, so padding a CV cannot raise the score', () => {
      const lean = run(['Python'], ['Python']);
      const padded = run(['Python'], ['Python', 'Java', 'Go', 'Rust', 'Scala', 'Perl']);

      expect(lean.composite).toBe(padded.composite);
    });

    it('is 0 when the job lists no required skills, rather than dividing by zero', () => {
      const result = run([], ['Python']);

      expect(result.featureVector.skill_overlap).toBe(0);
      expect(result.composite).toBe(0);
      expect(Number.isNaN(result.composite)).toBe(false);
    });

    it('honours per-job weights from FR4.2 rather than a second weighting system', () => {
      const custom: RankingWeights = {
        ...DEFAULT_RANKING_WEIGHTS,
        skill_overlap: 0.6,
        semantic_similarity: 0,
      };
      // 1 of 2 → 0.5 overlap, weighted at 0.6.
      expect(run(['Python', 'Go'], ['Python'], custom).composite).toBe(0.3);
    });

    it('never leaves [0,1], which the composite_score CHECK requires', () => {
      const absurd: RankingWeights = { ...DEFAULT_RANKING_WEIGHTS, skill_overlap: 5 };
      const result = run(['Python'], ['Python'], absurd);

      expect(result.composite).toBeLessThanOrEqual(1);
      expect(result.composite).toBeGreaterThanOrEqual(0);
    });

    it('is deterministic — the same inputs always give the same score', () => {
      const a = run(['TypeScript', 'React'], ['React']);
      const b = run(['TypeScript', 'React'], ['React']);

      expect(a.composite).toBe(b.composite);
      expect(a.featureVector).toEqual(b.featureVector);
    });
  });

  describe('matching', () => {
    it('is case-insensitive', () => {
      expect(run(['PostgreSQL'], ['postgresql']).featureVector.skill_overlap).toBe(1);
    });

    it('is whole-term, so Java does not satisfy a JavaScript requirement', () => {
      expect(run(['JavaScript'], ['Java']).featureVector.skill_overlap).toBe(0);
    });

    it('ignores a malformed skills column instead of throwing', () => {
      expect(run(null, undefined).composite).toBe(0);
      expect(run(['Python'], [42, null, 'Python']).featureVector.skill_overlap).toBe(1);
    });
  });

  describe('the feature vector (FR4.4)', () => {
    it('carries exactly the six allow-listed keys and passes BR-07', () => {
      const result = run(['Python'], ['Python']);

      expect(Object.keys(result.featureVector).sort()).toEqual([...ALLOWED_FEATURE_KEYS].sort());
      expect(() => assertAllowedFeatures(result.featureVector)).not.toThrow();
    });

    it('reports unmeasured features as an explicit 0, never as a missing key', () => {
      const result = run(['Python'], ['Python']);

      // Present-and-zero, so the stored vector stays reproducible.
      for (const key of [
        'semantic_similarity',
        'years_experience_delta',
        'recency_relevant_exp',
        'education_match',
        'certification_match',
      ]) {
        expect(result.featureVector[key]).toBe(0);
      }
    });
  });

  describe('the rationale (BR-02)', () => {
    it('is present and derived from the same numbers as the composite', () => {
      const result = run(['TypeScript', 'React', 'AWS', 'Kafka'], ['TypeScript', 'React']);

      expect(result.rationale.summary).toBeTruthy();
      expect(result.rationale.factors).toHaveLength(ALLOWED_FEATURE_KEYS.length);

      // Every factor is exactly weight x feature.
      for (const factor of result.rationale.factors) {
        const weight = DEFAULT_RANKING_WEIGHTS[factor.feature as keyof RankingWeights];
        const value = result.featureVector[factor.feature]!;
        expect(factor.contribution).toBeCloseTo(weight * value, 4);
      }

      // And the contributions sum to the composite.
      const total = result.rationale.factors.reduce((sum, f) => sum + f.contribution, 0);
      expect(total).toBeCloseTo(result.composite, 4);
    });

    it('names the matched skills and the count', () => {
      const result = run(['TypeScript', 'React', 'AWS'], ['TypeScript', 'React']);

      expect(result.rationale.summary).toContain('2 of 3 required skills');
      expect(result.rationale.summary).toContain('TypeScript');
    });

    it('states that it is not a trained model', () => {
      expect(run(['Python'], ['Python']).rationale.summary).toContain('not a trained model');
    });

    it('states that a zero means no evidence, not a deficiency', () => {
      const summary = run(['Python'], ['Python']).rationale.summary;

      expect(summary).toContain('5 of the 6 ranking features could not be measured');
      expect(summary).toContain('not that the candidate lacks it');
    });

    it('discloses the attainable ceiling so 0.30 is not read as a poor match', () => {
      expect(run(['Python'], ['Python']).rationale.summary).toContain(
        'highest attainable score is 0.30',
      );
    });

    it('says so plainly when the job lists no required skills', () => {
      expect(run([], ['Python']).rationale.summary).toContain('no required skills');
    });
  });

  describe('provenance (FR4.4)', () => {
    it('identifies itself as baseline-rules-v1', () => {
      const result = run(['Python'], ['Python']);

      expect(result.modelName).toBe('baseline-rules');
      expect(result.versionTag).toBe('baseline-rules-v1');
    });
  });

  describe('an unparsed application', () => {
    it('scores 0 with a rationale rather than throwing or inventing a value', () => {
      // What the worker would pass for a resume that produced no skills.
      const result = scorer.score({
        job: job(['Python', 'Django']),
        profile: { skills: [], workHistory: [], education: [], certifications: [] },
        weights: DEFAULT_RANKING_WEIGHTS,
      });

      expect(result.composite).toBe(0);
      expect(result.rationale.summary).toContain('Matched 0 of 2 required skills');
    });
  });
});
