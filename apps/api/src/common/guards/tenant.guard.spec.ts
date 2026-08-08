import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
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

describe('TenantGuard (BR-06, risk R-09)', () => {
  let reflector: Reflector;
  let guard: TenantGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new TenantGuard(reflector);
  });

  function requireRoles(roles: string[] | undefined) {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
  }

  it('allows public routes — nothing to scope', () => {
    requireRoles(undefined);
    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it('allows an authenticated user carrying a tenant', () => {
    requireRoles([UserRole.RECRUITER]);
    expect(
      guard.canActivate(makeContext({ role: UserRole.RECRUITER, companyId: 'company-1' })),
    ).toBe(true);
  });

  it('refuses a principal with no tenant rather than guessing a scope', () => {
    requireRoles([UserRole.RECRUITER]);
    expect(() =>
      guard.canActivate(makeContext({ role: UserRole.RECRUITER, companyId: '' })),
    ).toThrow(ForbiddenException);
  });

  it('denies a protected route with no principal', () => {
    requireRoles([UserRole.RECRUITER]);
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(ForbiddenException);
  });
});
