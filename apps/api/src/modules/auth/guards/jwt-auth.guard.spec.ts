import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from '../token.service';
import type { RequestContext } from '../../../common/types/authenticated-request';

const CONFIG = {
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
};

function makeContext(headers: Record<string, string> = {}) {
  const request = { headers } as unknown as RequestContext;
  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

describe('JwtAuthGuard', () => {
  let reflector: Reflector;
  let tokens: TokenService;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    reflector = new Reflector();
    tokens = new TokenService(new JwtService({}), {
      get: (k: string) => CONFIG[k as keyof typeof CONFIG],
    } as unknown as ConfigService);
    guard = new JwtAuthGuard(reflector, tokens);
  });

  function markPublic(isPublic: boolean | undefined) {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(isPublic);
  }

  it('allows a @Public() route with no token', async () => {
    markPublic(true);
    const { context } = makeContext();
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('DENY BY DEFAULT: rejects a protected route with no Authorization header', async () => {
    markPublic(undefined);
    const { context } = makeContext();
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a non-Bearer scheme', async () => {
    markPublic(undefined);
    const { context } = makeContext({ authorization: 'Basic dXNlcjpwYXNz' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a tampered token', async () => {
    markPublic(undefined);
    const token = await tokens.signAccessToken({
      sub: 'user-1',
      email: 'r@x.local',
      role: UserRole.RECRUITER,
      companyId: 'company-1',
    });
    const { context } = makeContext({ authorization: `Bearer ${token.slice(0, -3)}xyz` });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('populates the request context with identity, role and tenant', async () => {
    markPublic(undefined);
    const token = await tokens.signAccessToken({
      sub: 'user-1',
      email: 'r@talentlens.local',
      role: UserRole.RECRUITER,
      companyId: 'company-1',
    });
    const { context, request } = makeContext({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      id: 'user-1',
      email: 'r@talentlens.local',
      role: UserRole.RECRUITER,
      companyId: 'company-1',
    });
  });

  it('ignores a client-supplied role — the token is the only source', async () => {
    markPublic(undefined);
    const token = await tokens.signAccessToken({
      sub: 'user-1',
      email: 'r@talentlens.local',
      role: UserRole.CANDIDATE,
      companyId: 'company-1',
    });
    const { context, request } = makeContext({
      authorization: `Bearer ${token}`,
      'x-role': 'ADMIN',
    });

    await guard.canActivate(context);
    expect(request.user?.role).toBe(UserRole.CANDIDATE);
  });
});
