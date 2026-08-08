import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Declares which PRD §24.2 roles may reach a route.
 *
 * A route with no @Roles() is treated as public by RolesGuard — for example
 * the candidate application form (POST /v1/applications) and the public job
 * listing, both of which the PRD marks Public.
 *
 * Example — BR-04, Administrator only:
 *   @Roles('ADMIN')
 *   @Patch('admin/jobs/:id/ai-scoring')
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
