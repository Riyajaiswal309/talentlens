import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

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
