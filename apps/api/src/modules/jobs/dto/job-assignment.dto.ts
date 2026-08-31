import { IsUUID } from 'class-validator';
import { UserRole } from '@prisma/client';

/**
 * Roles that may be ASSIGNED to a job.
 *
 * HIRING_MANAGER and ADMIN, and that pair is not arbitrary. §24.2 narrows a
 * Hiring Manager to "assigned jobs only", and amendment D7 scopes
 * `GET /v1/me/reviews` for Administrators through `job_assignments` as well —
 * `ScorecardsService` applies that filter with no role branch. Those are the
 * two roles where a row actually changes what someone can see.
 *
 * CANDIDATE is refused for the obvious reason. RECRUITER is refused because the
 * row would be INERT: a Recruiter already reaches every job in their tenant,
 * and `/v1/me/reviews` is closed to them, so an assignment would grant nothing
 * while looking like it had. Storing data that does nothing is how a permission
 * model starts lying about itself.
 */
export const ASSIGNABLE_ROLES: readonly UserRole[] = [UserRole.HIRING_MANAGER, UserRole.ADMIN];

/** POST /v1/jobs/:id/assignments */
export class AssignJobDto {
  @IsUUID('4', { message: 'userId must be a valid user id' })
  userId!: string;
}

/**
 * One assignment as the API returns it.
 *
 * The user is denormalised to email and role rather than a bare id, matching
 * `GET /v1/interviewers` and the audit list: `users` holds no display name, and
 * an id alone would force every caller into a second request to render a row.
 */
export interface JobAssignmentResponse {
  id: string;
  userId: string;
  email: string;
  role: string;
  createdAt: string;
}
