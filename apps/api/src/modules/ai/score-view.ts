import type { ScoreResult } from './ai-scoring.port';

/**
 * The wire shape of a score (PRD §23.3), or null when there is none.
 *
 * Kept separate from the port's `MatchScoreView` so the HTTP contract and the
 * internal union can evolve independently — the port uses a discriminated
 * union because consumers must be forced to handle both branches, while the
 * wire keeps `score: null`, which is what M2.7 already publishes and what
 * FR4.5 describes ("no score displayed").
 */
export interface WireScore {
  composite: number;
  modelVersion: string;
  rationale: {
    summary: string;
    factors: { feature: string; contribution: number; direction: string }[];
  };
  overridden: boolean;
}

/**
 * Render a port result for the wire.
 *
 * The single place NotScored becomes `null`. Every consumer goes through
 * here, so the not-scored rendering cannot drift between endpoints — and
 * when Phase 3 starts returning real scores, no controller changes.
 */
export function toWireScore(result: ScoreResult): WireScore | null {
  if (!result.scored) return null;

  return {
    composite: result.composite,
    modelVersion: result.modelVersion,
    // BR-02 — the rationale is required by the type, so a score can never
    // reach the wire without one.
    rationale: result.rationale,
    overridden: result.overridden,
  };
}
