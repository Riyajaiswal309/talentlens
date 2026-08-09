import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** APPROVED (9 Aug 2026). Phase 1 HM-04 says "rating scale" without bounds. */
export const MIN_RATING = 1;
export const MAX_RATING = 5;

/**
 * POST /v1/applications/:id/scorecards (PRD §23.2, Handoff §B row 18, FR5.3).
 *
 * Two fields, matching the two columns the schema has. HM-04 also sketches
 * "structured prompts" and a "save draft" action; neither has storage and
 * both were explicitly deferred, so neither is accepted here — a field the
 * server would silently discard is worse than one that does not exist.
 */
export class CreateScorecardDto {
  @IsInt({ message: `rating must be a whole number between ${MIN_RATING} and ${MAX_RATING}` })
  @Min(MIN_RATING, { message: `rating must be between ${MIN_RATING} and ${MAX_RATING}` })
  @Max(MAX_RATING, { message: `rating must be between ${MIN_RATING} and ${MAX_RATING}` })
  rating!: number;

  /** Optional: `scorecards.feedback` is nullable. A rating alone is valid. */
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  feedback?: string;
}
