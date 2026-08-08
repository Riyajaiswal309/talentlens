import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { UserRole } from '@prisma/client';

/** Claims carried by the access token. Enough to populate RequestContext. */
export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: UserRole;
  companyId: string;
}

export interface RefreshTokenClaims {
  sub: string;
  /** Unique per issued token — the handle rotation revokes (PRD §24.1). */
  jti: string;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtl: string;
  private readonly refreshTtl: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    // PRD §24.1 — 15 minute access token, 7 day refresh token.
    this.accessSecret = config.get<string>('JWT_ACCESS_SECRET') ?? '';
    this.refreshSecret = config.get<string>('JWT_REFRESH_SECRET') ?? '';
    this.accessTtl = config.get<string>('JWT_ACCESS_TTL') ?? '15m';
    this.refreshTtl = config.get<string>('JWT_REFRESH_TTL') ?? '7d';

    if (!this.accessSecret || !this.refreshSecret) {
      throw new Error(
        'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set. ' +
          'Generate them with: openssl rand -base64 48',
      );
    }
    if (this.accessSecret === this.refreshSecret) {
      // Sharing one secret would let an access token be replayed as a refresh
      // token, defeating the short access TTL entirely.
      throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ.');
    }
  }

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return this.jwt.signAsync(claims, {
      secret: this.accessSecret,
      expiresIn: this.accessTtl,
    });
  }

  /** Returns the token and its jti so the caller can register it for rotation. */
  async signRefreshToken(userId: string): Promise<{ token: string; jti: string }> {
    const jti = randomUUID();
    const token = await this.jwt.signAsync({ sub: userId, jti } satisfies RefreshTokenClaims, {
      secret: this.refreshSecret,
      expiresIn: this.refreshTtl,
    });
    return { token, jti };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.accessSecret,
      });
    } catch {
      // Expired or tampered. Never log the token itself.
      return null;
    }
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenClaims | null> {
    try {
      return await this.jwt.verifyAsync<RefreshTokenClaims>(token, {
        secret: this.refreshSecret,
      });
    } catch {
      return null;
    }
  }

  /** Seconds until a refresh token expires — used as the Redis TTL. */
  refreshTtlSeconds(): number {
    return parseDuration(this.refreshTtl);
  }
}

function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) return 7 * 24 * 60 * 60;
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return amount * (multipliers[unit as string] ?? 86400);
}
