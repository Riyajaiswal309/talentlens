/**
 * Shared types between apps/web and apps/api.
 *
 * Phase 2 scope: only the four user roles are defined here, because RBAC
 * (FR8.1) is the first cross-cutting concern both sides must agree on.
 *
 * DTOs are NOT hand-written. PRD §23.1 requires them to be generated from the
 * OpenAPI spec produced by @nestjs/swagger. That generation step lands in M2.4
 * once the first endpoints exist.
 */

/** PRD §24.2 Table 24.1 — the four roles. */
export const USER_ROLES = ['ADMIN', 'RECRUITER', 'HIRING_MANAGER', 'CANDIDATE'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * PRD §14.1 — the six default pipeline stages.
 *
 * These are DEFAULTS ONLY. FR5.1 requires stages to be configurable per job,
 * so they are seeded into the `pipeline_stages` table per job rather than
 * hard-coded as an application constant (decision B2, 8 Aug 2026).
 * "Shortlisted" is available as a per-job addition, not a global stage.
 */
export const DEFAULT_PIPELINE_STAGES = [
  'Applied',
  'Screening',
  'Interview',
  'Offer',
  'Hired',
  'Rejected',
] as const;

export type DefaultPipelineStage = (typeof DEFAULT_PIPELINE_STAGES)[number];
