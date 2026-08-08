import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { RolesGuard } from './roles.guard';
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

describe('RolesGuard (PRD §24.2)', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  function requireRoles(roles: UserRole[] | undefined) {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
  }

  it('allows routes with no @Roles() — PRD marks several endpoints Public', () => {
    requireRoles(undefined);
    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it('allows a user holding a required role', () => {
    requireRoles([UserRole.RECRUITER, UserRole.ADMIN]);
    expect(guard.canActivate(makeContext({ role: UserRole.RECRUITER }))).toBe(true);
  });

  it('BR-04: a RECRUITER is denied an ADMIN-only route (AI scoring toggle)', () => {
    requireRoles([UserRole.ADMIN]);
    expect(() => guard.canActivate(makeContext({ role: UserRole.RECRUITER }))).toThrow(
      ForbiddenException,
    );
  });

  it('denies a role-restricted route when no principal is present', () => {
    requireRoles([UserRole.ADMIN]);
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(ForbiddenException);
  });

  it('does not disclose which role was required', () => {
    requireRoles([UserRole.ADMIN]);
    try {
      guard.canActivate(makeContext({ role: UserRole.CANDIDATE }));
      fail('expected ForbiddenException');
    } catch (e) {
      expect((e as Error).message).toBe('Insufficient permissions');
      expect((e as Error).message).not.toContain('ADMIN');
    }
  });
});
