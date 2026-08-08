import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { TokenService } from './token.service';

const BASE = {
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
};

function config(overrides: Partial<typeof BASE> = {}): ConfigService {
  const merged = { ...BASE, ...overrides };
  return { get: (k: string) => merged[k as keyof typeof merged] } as unknown as ConfigService;
}

const CLAIMS = {
  sub: 'user-1',
  email: 'r@talentlens.local',
  role: UserRole.RECRUITER,
  companyId: 'company-1',
};

describe('TokenService (PRD §24.1)', () => {
  const service = new TokenService(new JwtService({}), config());

  it('signs and verifies an access token, preserving role and tenant', async () => {
    const token = await service.signAccessToken(CLAIMS);
    const claims = await service.verifyAccessToken(token);

    expect(claims?.sub).toBe('user-1');
    expect(claims?.role).toBe(UserRole.RECRUITER);
    expect(claims?.companyId).toBe('company-1');
  });

  it('returns null for a tampered access token instead of throwing', async () => {
    const token = await service.signAccessToken(CLAIMS);
    const tampered = `${token.slice(0, -3)}xyz`;
    await expect(service.verifyAccessToken(tampered)).resolves.toBeNull();
  });

  it('issues a unique jti per refresh token so each can be revoked separately', async () => {
    const a = await service.signRefreshToken('user-1');
    const b = await service.signRefreshToken('user-1');
    expect(a.jti).not.toBe(b.jti);
  });

  it('will NOT accept an access token as a refresh token (separate secrets)', async () => {
    const accessToken = await service.signAccessToken(CLAIMS);
    await expect(service.verifyRefreshToken(accessToken)).resolves.toBeNull();
  });

  it('will NOT accept a refresh token as an access token', async () => {
    const { token } = await service.signRefreshToken('user-1');
    await expect(service.verifyAccessToken(token)).resolves.toBeNull();
  });

  it('refuses to start when the two secrets are identical', () => {
    expect(
      () => new TokenService(new JwtService({}), config({ JWT_REFRESH_SECRET: 'access-secret' })),
    ).toThrow(/must differ/);
  });

  it('refuses to start when a secret is missing', () => {
    expect(() => new TokenService(new JwtService({}), config({ JWT_ACCESS_SECRET: '' }))).toThrow(
      /must be set/,
    );
  });

  it('converts the refresh TTL to seconds for the store', () => {
    expect(service.refreshTtlSeconds()).toBe(7 * 24 * 60 * 60);
  });
});
