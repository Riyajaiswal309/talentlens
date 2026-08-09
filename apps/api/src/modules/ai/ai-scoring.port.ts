import { Injectable } from '@nestjs/common';

/**
 * One contributing factor from the SHAP attribution (PRD §22.2, §23.3).
 *
 * `feature` is restricted to the Table 19.1 allow-list (BR-07). The
 * allow-list itself is not enforced here — nothing in Phase 2 produces
 * features — but the field exists so Phase 3 has a place to be checked.
 */
export interface ScoreRationaleFactor {
  feature: string;
  contribution: number;
  direction: 'positive' | 'negative';
}

/**
 * The explanation attached to every score.
 *
 * NOT OPTIONAL, and that is the point. BR-02: "AI-generated rankings must
 * always be presented with a rationale; a score without an explanation may
 * not be surfaced." The database enforces it with `rationale NOT NULL`; this
 * type enforces the same rule at compile time, so a consumer cannot render a
 * score it has no explanation for.
 */
export interface ScoreRationale {
  summary: string;
  factors: ScoreRationaleFactor[];
}

/** A scored application (PRD §23.3 payload). Never produced in Phase 2. */
export interface MatchScoreView {
  scored: true;
  composite: number;
  modelVersion: string;
  rationale: ScoreRationale;
  /** FR4.3 — set once a recruiter has overridden the AI value. */
  overridden: boolean;
}

/**
 * No score is available.
 *
 * Deliberately carries no reason code. Phase 1 distinguishes "AI disabled"
 * (FR4.5) from "not scored yet" at the SCREEN level, but no document asks the
 * port to tell them apart, and Phase 2 has exactly one cause. A field can be
 * added later without breaking consumers; inventing one now could not be
 * justified from the specification.
 */
export interface NotScored {
  scored: false;
}

export type ScoreResult = MatchScoreView | NotScored;

/**
 * The single seam between the core API and the AI service
 * (Handoff §G, PRD §15.1 principle 1, §19.1).
 *
 * WHY A DISCRIMINATED UNION: `scored` forces every consumer to handle the
 * not-scored branch before it can reach a composite value. Handoff §G says
 * "every consumer therefore exercises the not-scored path from day one" —
 * with this shape that is a compile error rather than a discipline.
 *
 * WHY AN ABSTRACT CLASS: it survives to runtime and can serve as its own
 * injection token. A TypeScript interface cannot.
 *
 * BOUNDARY RULES BINDING ON PHASE 3 (Handoff §G):
 *   - The core API never imports model code; it speaks HTTP and events only.
 *     Nothing behind this port may leak a model type through it.
 *   - A degraded or absent AI service must not degrade the recruiter
 *     workflow (PRD §15.1), which is why `getScore` returns NotScored rather
 *     than throwing when there is nothing to report.
 *   - AI output is advisory. No implementation of this port may transition an
 *     application's stage (BR-01) — the port has no method that could.
 */
@Injectable()
export abstract class AiScoringPort {
  /**
   * Ask for a resume to be parsed. Fire-and-forget, queued.
   *
   * PHASE 2 NOTE: intake does NOT call this. `ApplicationsService` publishes
   * `resume.uploaded` to BullMQ directly, per the PRD §23.1 sequence, and
   * that flow is committed and tested (M2.7 step 4). The method exists here
   * because Handoff §G fixes it as part of the contract Phase 3 must satisfy;
   * rewiring intake through a no-op would delete working behaviour.
   */
  abstract requestParse(resumeId: string): Promise<void>;

  /**
   * The current score for an application, or NotScored.
   *
   * Returns rather than throws when unavailable: PRD §15.1 requires that a
   * degraded AI service leaves the recruiter workflow intact.
   */
  abstract getScore(applicationId: string): Promise<ScoreResult>;
}
