import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { RequestContext } from '../types/authenticated-request';

/**
 * Enforces the PRD §24.2 Table 24.1 permission matrix at the route level.
 *
 * PRD NFR6 requires role checks at the API layer, "not only the UI" — this
 * guard is that layer. Hiding a button is a usability choice; this is the
 * control.
 *
 * A route with no @Roles() metadata is public by design: PRD §23.2 marks
 * several endpoints Public (candidate application form, public job listing).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestContext>();
    const user = request.user;

    // No principal on a role-restricted route. 403 rather than 401 because
    // M2.4's auth guard is what distinguishes "not signed in"; by the time
    // this guard runs, a missing user means not permitted.
    if (!user) throw new ForbiddenException('Insufficient permissions');

    if (!required.includes(user.role)) {
      // Deliberately does not name the required role — that would disclose
      // the permission model to an unauthorised caller.
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
