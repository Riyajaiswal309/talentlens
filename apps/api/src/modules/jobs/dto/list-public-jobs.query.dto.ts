import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/**
 * Query for GET /v1/public/jobs (Handoff §B row 10).
 *
 * Cursor pagination only. PRD §23.1 fixes `?cursor=&limit=` for every list
 * endpoint, and no document specifies public filters — so `status` and
 * `department`, which the authenticated ListJobsQueryDto accepts, are
 * deliberately absent rather than guessed at. `status` in particular must not
 * be a public parameter: the listing shows PUBLISHED roles and nothing else,
 * and accepting the filter would invite callers to ask for DRAFT.
 */
export class ListPublicJobsQueryDto {
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
