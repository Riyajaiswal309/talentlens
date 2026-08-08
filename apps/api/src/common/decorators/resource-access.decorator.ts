import { SetMetadata } from '@nestjs/common';

export const CANDIDATE_OWNED_KEY = 'candidateOwned';
export const JOB_SCOPED_KEY = 'jobScoped';

/** Resource kinds whose ownership can be resolved back to a candidate. */
export type OwnedResource = 'application' | 'candidate';

export interface CandidateOwnedMetadata {
  resource: OwnedResource;
  /** Route param carrying the resource id. Defaults to 'id'. */
  param?: string;
}

/**
 * Marks a route whose resource belongs to a specific candidate (BR-06).
 *
 * CandidateOwnershipGuard only constrains callers whose role is CANDIDATE.
 * Recruiters, Hiring Managers and Administrators are governed by RolesGuard,
 * TenantGuard and JobAssignmentGuard instead.
 *
 *   @CandidateOwned({ resource: 'application' })
 *   @Get('applications/:id')
 */
export const CandidateOwned = (metadata: CandidateOwnedMetadata) =>
  SetMetadata(CANDIDATE_OWNED_KEY, metadata);

export interface JobScopedMetadata {
  /** Route param carrying the job id. Defaults to 'id'. */
  param?: string;
}

/**
 * Marks a route that operates on a specific job (PRD §24.2).
 *
 * JobAssignmentGuard uses this to enforce the Hiring Manager's
 * "assigned jobs only" restriction via the job_assignments table (decision
 * B1). Other roles are unaffected here; tenancy still applies to them.
 *
 *   @JobScoped()
 *   @Get('jobs/:id/candidates')
 */
export const JobScoped = (metadata: JobScopedMetadata = {}) =>
  SetMetadata(JOB_SCOPED_KEY, metadata);
