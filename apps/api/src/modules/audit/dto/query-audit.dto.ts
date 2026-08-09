import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { AUDIT_ACTIONS } from '../audit-actions';

/** APPROVED (D8) — Gap 4 sets no bound; 366 days protects NFR1. */
export const MAX_RANGE_DAYS = 366;

/** GET /v1/audit-logs — Handoff Gap 4. */
export class QueryAuditDto {
  /**
   * Approved wider meaning: the job itself, its applications, and the
   * scorecards and match scores belonging to those applications.
   */
  @IsOptional()
  @IsUUID('4', { message: 'jobId must be a valid job identifier' })
  jobId?: string;

  @IsOptional()
  @IsDateString({}, { message: 'from must be an ISO 8601 date-time' })
  from?: string;

  @IsOptional()
  @IsDateString({}, { message: 'to must be an ISO 8601 date-time' })
  to?: string;

  @IsOptional()
  @IsIn(AUDIT_ACTIONS as unknown as string[], { message: 'actionType is not a known action' })
  actionType?: string;

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

/** GET /v1/audit-logs/export — same filters, plus a format. */
export class ExportAuditDto extends QueryAuditDto {
  @IsOptional()
  @IsIn(['csv', 'json'], { message: "format must be 'csv' or 'json'" })
  format?: 'csv' | 'json';
}
