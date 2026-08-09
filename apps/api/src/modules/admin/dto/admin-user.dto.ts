import { Type } from 'class-transformer';
import { IsEmail, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { UserRole } from '@prisma/client';

/**
 * Roles an Administrator may assign (Handoff Gap 5 validation rule 2).
 *
 * CANDIDATE is deliberately absent. Candidate identity is created by
 * application submission and lives in `candidates`, which PRD §17.2 keeps
 * separate from `users`; offering it here would let an admin mint a login
 * that no candidate profile corresponds to.
 */
export enum AssignableRole {
  ADMIN = 'ADMIN',
  RECRUITER = 'RECRUITER',
  HIRING_MANAGER = 'HIRING_MANAGER',
}

/** Compile-time proof that every assignable value is a real UserRole. */
const _assignableAreRoles: Record<AssignableRole, UserRole> = {
  [AssignableRole.ADMIN]: UserRole.ADMIN,
  [AssignableRole.RECRUITER]: UserRole.RECRUITER,
  [AssignableRole.HIRING_MANAGER]: UserRole.HIRING_MANAGER,
};
void _assignableAreRoles;

const ROLE_MESSAGE = 'role must be ADMIN, RECRUITER or HIRING_MANAGER';

/** GET /v1/admin/users — Gap 5. */
export class ListUsersQueryDto {
  @IsOptional()
  @IsEnum(AssignableRole, { message: ROLE_MESSAGE })
  role?: AssignableRole;

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

/** POST /v1/admin/users — Gap 5. */
export class CreateUserDto {
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(320)
  email!: string;

  @IsEnum(AssignableRole, { message: ROLE_MESSAGE })
  role!: AssignableRole;
}

/** PATCH /v1/admin/users/:id/role — Gap 5. */
export class ChangeRoleDto {
  @IsEnum(AssignableRole, { message: ROLE_MESSAGE })
  role!: AssignableRole;
}
