import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * GET /v1/interviewers — the picker source for RC-11 (FR6.1/FR6.3).
 *
 * The endpoint exists because `GET /v1/admin/users` is `@Roles(ADMIN)`: a
 * Recruiter — the role that actually schedules — could not name a single
 * interviewer, which made the whole scheduling screen unbuildable. This is a
 * strictly narrower read of the same table, not a relaxation of that route.
 */
export class ListInterviewersQueryDto {
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

/**
 * One selectable interviewer.
 *
 * THERE IS NO `name` FIELD, and that is a schema fact rather than an omission:
 * `users` stores `id`, `companyId`, `email`, `role`, `passwordHash`,
 * `lastActiveAt` and timestamps — no display name anywhere. Adding one would
 * need a migration, which this phase forbids, and inventing a name split from
 * the email address would be a guess presented as data. The email is the
 * identifying label, exactly as it is on the audit log and the admin table.
 *
 * `passwordHash` and `lastActiveAt` are deliberately absent: a picker needs to
 * know who may be chosen, not how they authenticate or when they last logged
 * in.
 */
export interface InterviewerResponse {
  id: string;
  email: string;
  role: string;
}
