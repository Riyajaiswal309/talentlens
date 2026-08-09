import { IsNumber, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/**
 * PATCH /v1/applications/:id/score (PRD §23.2, Handoff §B row 17, FR4.3).
 *
 * Phase 1 Flow 6 step 5 names exactly two fields: `overrideScore` and
 * `reason`. Nothing else is accepted — `forbidNonWhitelisted` turns an
 * attempt to set `overriddenBy` or a model version into a 400, so a caller
 * cannot attribute an override to someone else.
 */
export class OverrideScoreDto {
  /**
   * Bounded to match the database: `match_scores.composite_score` carries a
   * CHECK (composite_score BETWEEN 0 AND 1). Validating here turns a
   * constraint violation into a readable 400.
   */
  @IsNumber({}, { message: 'overrideScore must be a number between 0 and 1' })
  @Min(0, { message: 'overrideScore must be between 0 and 1' })
  @Max(1, { message: 'overrideScore must be between 0 and 1' })
  overrideScore!: number;

  /**
   * BR-03 — "Any recruiter override of an AI score must be logged, including
   * the reason where provided." Phase 1 RC-07 disables Confirm until the
   * reason is non-empty, so the server requires it too: the UI rule is not
   * the enforcement point (NFR6).
   */
  @IsString({ message: 'A reason is required to override a score' })
  // \S rather than MinLength(1): "   " is a non-empty string but not a
  // reason, and BR-03 wants something a later auditor can read.
  @Matches(/\S/, { message: 'A reason is required to override a score' })
  @MaxLength(2000, { message: 'A reason must be 2000 characters or fewer' })
  reason!: string;
}
