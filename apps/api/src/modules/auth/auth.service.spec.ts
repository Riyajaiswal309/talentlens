import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import type { RefreshTokenStore } from './refresh-token.store';
import type { PrismaService } from '../../common/prisma/prisma.service';

const CONFIG = {
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
};

function makeConfig(): ConfigService {
  return { get: (k: string) => CONFIG[k as keyof typeof CONFIG] } as unknown as ConfigService;
}

const SEEDED_USER = {
  id: 'user-1',
  email: 'recruiter@talentlens.local',
  role: UserRole.RECRUITER,
  companyId: 'company-1',
  passwordHash: '',
};

describe('AuthService (PRD §24.1)', () => {
  let passwords: PasswordService;
  let tokens: TokenService;
  let prisma: { users: { findFirst: jest.Mock; findUnique: jest.Mock; update: jest.Mock } };
  let store: {
    register: jest.Mock;
    consume: jest.Mock;
    revokeAll: jest.Mock;
    countLive: jest.Mock;
  };
  let service: AuthService;

  beforeAll(async () => {
    passwords = new PasswordService();
    SEEDED_USER.passwordHash = await passwords.hash('DevPassword123!');
  });

  beforeEach(() => {
    tokens = new TokenService(new JwtService({}), makeConfig());
    prisma = {
      users: {
        findFirst: jest.fn().mockResolvedValue({ ...SEEDED_USER }),
        findUnique: jest.fn().mockResolvedValue({ ...SEEDED_USER }),
        update: jest.fn().mockResolvedValue({ ...SEEDED_USER }),
      },
    };
    store = {
      register: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue(true),
      revokeAll: jest.fn().mockResolvedValue(2),
      countLive: jest.fn().mockResolvedValue(0),
    };
    service = new AuthService(
      prisma as unknown as PrismaService,
      passwords,
      tokens,
      store as unknown as RefreshTokenStore,
    );
  });

  describe('login', () => {
    it('succeeds with correct credentials and returns both tokens', async () => {
      const result = await service.login('recruiter@talentlens.local', 'DevPassword123!');

      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
      expect(result.identity).toEqual({
        id: 'user-1',
        email: 'recruiter@talentlens.local',
        role: UserRole.RECRUITER,
        companyId: 'company-1',
      });
    });

    it('registers the refresh token so it can later be rotated/revoked', async () => {
      await service.login('recruiter@talentlens.local', 'DevPassword123!');
      expect(store.register).toHaveBeenCalledTimes(1);
    });

    it('never returns the password hash in the identity', async () => {
      const result = await service.login('recruiter@talentlens.local', 'DevPassword123!');
      expect(JSON.stringify(result.identity)).not.toContain('argon2');
      // The field must be absent entirely, not merely undefined.
      expect(Object.keys(result.identity)).toEqual(['id', 'email', 'role', 'companyId']);
    });

    it('rejects a wrong password', async () => {
      await expect(
        service.login('recruiter@talentlens.local', 'WrongPassword123!'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an unknown email', async () => {
      prisma.users.findFirst.mockResolvedValue(null);
      await expect(service.login('nobody@talentlens.local', 'DevPassword123!')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('gives the SAME message for unknown email and wrong password (no enumeration)', async () => {
      const wrongPassword = await service
        .login('recruiter@talentlens.local', 'WrongPassword123!')
        .catch((e: Error) => e.message);

      prisma.users.findFirst.mockResolvedValue(null);
      const unknownEmail = await service
        .login('nobody@talentlens.local', 'DevPassword123!')
        .catch((e: Error) => e.message);

      expect(wrongPassword).toBe(unknownEmail);
      expect(wrongPassword).toBe('Email or password is incorrect');
    });

    it('rejects an SSO-only account without revealing that it is SSO-only', async () => {
      prisma.users.findFirst.mockResolvedValue({ ...SEEDED_USER, passwordHash: null });
      await expect(service.login('recruiter@talentlens.local', 'DevPassword123!')).rejects.toThrow(
        'Email or password is incorrect',
      );
    });
  });

  describe('refresh rotation (PRD §24.1)', () => {
    it('issues a NEW refresh token and consumes the old one', async () => {
      const { refreshToken } = await service.login('recruiter@talentlens.local', 'DevPassword123!');

      const rotated = await service.refresh(refreshToken);

      expect(store.consume).toHaveBeenCalledTimes(1);
      expect(rotated.refreshToken).not.toBe(refreshToken);
      expect(rotated.accessToken).toBeTruthy();
    });

    it('rejects a token whose signature does not verify', async () => {
      await expect(service.refresh('not-a-jwt')).rejects.toThrow(UnauthorizedException);
    });

    it('REUSE DETECTION: a replayed token revokes the whole family', async () => {
      const { refreshToken } = await service.login('recruiter@talentlens.local', 'DevPassword123!');

      // Simulate the jti already having been consumed.
      store.consume.mockResolvedValue(false);

      await expect(service.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);

      // Revoking only the replayed token would leave a thief holding a live one.
      expect(store.revokeAll).toHaveBeenCalledWith('user-1');
    });

    it('rejects refresh for a user that no longer exists', async () => {
      const { refreshToken } = await service.login('recruiter@talentlens.local', 'DevPassword123!');
      prisma.users.findUnique.mockResolvedValue(null);

      await expect(service.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('logout', () => {
    it('consumes the presented refresh token', async () => {
      const { refreshToken } = await service.login('recruiter@talentlens.local', 'DevPassword123!');
      await service.logout(refreshToken);
      expect(store.consume).toHaveBeenCalled();
    });

    it('is idempotent when no cookie is present', async () => {
      await expect(service.logout(undefined)).resolves.toBeUndefined();
      expect(store.consume).not.toHaveBeenCalled();
    });

    it('is idempotent for an already-invalid token', async () => {
      await expect(service.logout('garbage')).resolves.toBeUndefined();
      expect(store.consume).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllSessions (FR8.4)', () => {
    it('delegates to the store and reports how many were revoked', async () => {
      await expect(service.revokeAllSessions('user-1')).resolves.toBe(2);
      expect(store.revokeAll).toHaveBeenCalledWith('user-1');
    });
  });
});
