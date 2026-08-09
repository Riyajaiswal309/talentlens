import { IsDateString, IsOptional, IsUUID } from 'class-validator';

/**
 * Query for GET /v1/analytics/funnel (PRD §23.2, Phase 1 RC-12).
 *
 * RC-12 lists a "date filter" and a "Change range" action, which `from` and
 * `to` serve. FR7.2 requires the metrics "per role", which `jobId` serves —
 * "role" in §11.7 means the requisition, not the RBAC role.
 *
 * NOTHING ELSE IS ACCEPTED. `forbidNonWhitelisted` turns an unrecognised
 * parameter into a 400 rather than ignoring it, so a caller cannot believe a
 * filter applied when it did not — the same rule the candidate list follows.
 *
 * No maximum span is imposed. The audit browser caps at 366 days because
 * Handoff decision D8 says so; no document says anything equivalent about
 * analytics, and inventing a limit would silently truncate a legitimate
 * year-on-year comparison.
 */
export class FunnelQueryDto {
  /** Inclusive lower bound on `applications.applied_at`. */
  @IsOptional()
  @IsDateString({}, { message: 'from must be an ISO 8601 date-time' })
  from?: string;

  /** Inclusive upper bound on `applications.applied_at`. */
  @IsOptional()
  @IsDateString({}, { message: 'to must be an ISO 8601 date-time' })
  to?: string;

  /** FR7.2 — narrow to one requisition. Omitted means the whole tenant. */
  @IsOptional()
  @IsUUID('4', { message: 'jobId must be a valid job id' })
  jobId?: string;
}
