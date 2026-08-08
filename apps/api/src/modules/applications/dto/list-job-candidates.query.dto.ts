import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Query for GET /v1/jobs/:id/candidates (Handoff §B row 14, RC-05).
 *
 * Cursor pagination only, per PRD §23.1. RC-05 also shows a filter bar, but
 * no document specifies which filters or their parameter names, so none are
 * accepted here rather than guessed at — `forbidNonWhitelisted` turns an
 * unrecognised one into a 400 instead of silently ignoring it and returning
 * a list the caller believes is filtered.
 */
export class ListJobCandidatesQueryDto {
  /** Opaque to clients: the id of the last row from the previous page. */
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'limit must be between 1 and 100' })
  @Max(100, { message: 'limit must be between 1 and 100' })
  limit?: number;
}
