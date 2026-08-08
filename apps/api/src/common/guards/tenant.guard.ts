import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { RequestContext } from '../types/authenticated-request';

/**
 * Multi-tenant isolation (PRD BR-06, risk R-09 "cross-tenant data leakage
 * through a missed query scope").
 *
 * Applied GLOBALLY rather than per-service, which is exactly the mitigation
 * the PRD names for R-09: a service that forgets to scope a query is the
 * expected failure mode, so the boundary is enforced at framework level.
 *
 * This guard asserts that every AUTHENTICATED request carries a companyId.
 * It keys off the presence of a principal rather than @Roles() so that
 * authenticated-but-unrestricted routes (GET /v1/auth/me) are covered too.
 * Public routes have no principal and nothing to scope.
 *
 * Row-level scoping using companyId belongs to the repositories, and
 * candidate-level ownership (CandidateOwnershipGuard) is M2.5.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestContext>();
    const user = request.user;

    // No principal — a public route. JwtAuthGuard has already enforced
    // authentication anywhere it was required.
    if (!user) return true;

    if (!user.companyId) {
      // An authenticated principal with no tenant cannot be scoped, so no
      // query it makes could be proven safe. Refuse rather than guess.
      throw new ForbiddenException('Request is not scoped to a tenant');
    }

    return true;
  }
}
