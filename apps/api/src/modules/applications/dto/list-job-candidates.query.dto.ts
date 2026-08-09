import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

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
  /**
   * Opaque to clients: the id of the last row from the previous page.
   *
   * Validated as a UUID so a malformed value is a 400 rather than a 500 —
   * left as a bare string it reaches Postgres and fails the uuid cast.
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
