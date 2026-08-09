import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** Handoff Gap 1 — the two tabs on HM-01 ("Awaiting" / "Completed"). */
export enum ReviewStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
}

/**
 * GET /v1/me/reviews (Handoff §B row 19, Gap 1).
 *
 * Note what is NOT here: no `userId`, no `jobId`, no company. Gap 1
 * validation rule 3 requires the scope to be derived server-side from
 * `job_assignments` and states that "the client cannot widen this scope by
 * parameter" (PRD NFR6). Any parameter that could widen it is therefore
 * absent rather than validated, and `forbidNonWhitelisted` turns an attempt
 * to supply one into a 400.
 */
export class ListReviewsQueryDto {
  @IsOptional()
  @IsEnum(ReviewStatus, { message: "status must be either 'pending' or 'completed'" })
  status?: ReviewStatus;

  /**
   * Opaque to clients: the id of the last row from the previous page.
   *
   * Validated as a UUID because Gap 1 requires a malformed cursor to be a
   * 400. Left as a bare string it would reach Postgres and fail the uuid
   * cast as a 500.
   */
  @IsOptional()
  @IsUUID('4', { message: 'cursor is not a valid page marker' })
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'limit must be between 1 and 100' })
  @Max(100, { message: 'limit must be between 1 and 100' })
  limit?: number;
}
