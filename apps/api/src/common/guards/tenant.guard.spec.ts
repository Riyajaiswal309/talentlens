import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { TenantGuard } from './tenant.guard';
import type { AuthenticatedUser, RequestContext } from '../types/authenticated-request';

function makeContext(user?: Partial<AuthenticatedUser>) {
  const request = { user } as unknown as RequestContext;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * Reworked in M2.4: the guard now keys off the presence of an authenticated
 * principal rather than @Roles(), so authenticated-but-unrestricted routes
 * (GET /v1/auth/me) are tenant-checked too. JwtAuthGuard is what enforces
 * that authentication happened at all.
 */
describe('TenantGuard (BR-06, risk R-09)', () => {
  const guard = new TenantGuard();

  it('allows public routes — no principal, nothing to scope', () => {
    expect(guard.canActivate(makeContext(undefined))).toBe(true);
  });

  it('allows an authenticated user carrying a tenant', () => {
    expect(
      guard.canActivate(makeContext({ role: UserRole.RECRUITER, companyId: 'company-1' })),
    ).toBe(true);
  });

  it('refuses a principal with an empty tenant rather than guessing a scope', () => {
    expect(() =>
      guard.canActivate(makeContext({ role: UserRole.RECRUITER, companyId: '' })),
    ).toThrow(ForbiddenException);
  });

  it('refuses a principal with no tenant field at all', () => {
    expect(() => guard.canActivate(makeContext({ role: UserRole.ADMIN }))).toThrow(
      ForbiddenException,
    );
  });

  it('applies to every role, including ADMIN — no tenant, no access', () => {
    for (const role of Object.values(UserRole)) {
      expect(() => guard.canActivate(makeContext({ role, companyId: '' }))).toThrow(
        ForbiddenException,
      );
    }
  });
});
