import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PasswordService } from './password.service';
import { RefreshTokenStore } from './refresh-token.store';
import { TokenService } from './token.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthenticatedIdentity {
  id: string;
  email: string;
  role: UserRole;
  companyId: string;
}

/**
 * A single message for every credential failure.
 *
 * Distinguishing "no such account" from "wrong password", or revealing that an
 * account is SSO-only, would turn the login form into an account-enumeration
 * oracle.
 */
const INVALID_CREDENTIALS = 'Email or password is incorrect';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly refreshStore: RefreshTokenStore,
  ) {}

  async login(
    email: string,
    password: string,
  ): Promise<{ identity: AuthenticatedIdentity } & TokenPair> {
    const user = await this.prisma.users.findFirst({
      where: { email: email.toLowerCase().trim() },
    });

    // Spend the same time whether or not the account exists (see
    // PasswordService.verifyDummy).
    if (!user || !user.passwordHash) {
      await this.passwords.verifyDummy(password);
      this.logger.warn(`Failed login for '${email}'`);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok) {
      this.logger.warn(`Failed login for '${email}'`);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    /*
     * PRD §24.1 requires TOTP MFA for the Administrator role. It is NOT
     * implemented in M2.4 — see the M2.4 report. An Administrator therefore
     * completes login with a password alone, which does not yet satisfy
     * §24.1. Flagged rather than silently accepted.
     */

    await this.prisma.users.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });

    const identity: AuthenticatedIdentity = {
      id: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
    };

    return { identity, ...(await this.issueTokens(identity)) };
  }

  /**
   * Rotate a refresh token (PRD §24.1).
   *
   * The old token is consumed atomically before a new pair is issued, so the
   * previous token stops working the instant it is used.
   */
  async refresh(refreshToken: string): Promise<{ identity: AuthenticatedIdentity } & TokenPair> {
    const claims = await this.tokens.verifyRefreshToken(refreshToken);
    if (!claims) throw new UnauthorizedException('Invalid refresh token');

    const consumed = await this.refreshStore.consume(claims.sub, claims.jti);

    if (!consumed) {
      /*
       * REUSE DETECTED (PRD §24.1 — "a replayed stolen token is detectable").
       *
       * The signature is valid but the jti is no longer live, so this exact
       * token was already exchanged. Either it was stolen and replayed, or
       * the legitimate holder's replacement was also stolen. We cannot tell
       * which, so we revoke the user's entire token family and force a fresh
       * login. Revoking only this token would leave a thief holding a working
       * one.
       */
      const revoked = await this.refreshStore.revokeAll(claims.sub);
      this.logger.error(
        `Refresh token reuse detected for user ${claims.sub}. ` +
          `Revoked ${revoked} live token(s); re-authentication required.`,
      );
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.users.findUnique({ where: { id: claims.sub } });
    if (!user) throw new UnauthorizedException('Invalid refresh token');

    const identity: AuthenticatedIdentity = {
      id: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
    };

    return { identity, ...(await this.issueTokens(identity)) };
  }

  /** Revoke the presented refresh token only. */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const claims = await this.tokens.verifyRefreshToken(refreshToken);
    if (!claims) return; // Already invalid — logout is idempotent.
    await this.refreshStore.consume(claims.sub, claims.jti);
  }

  /** FR8.4 — revoke every live refresh token for a user. */
  async revokeAllSessions(userId: string): Promise<number> {
    return this.refreshStore.revokeAll(userId);
  }

  private async issueTokens(identity: AuthenticatedIdentity): Promise<TokenPair> {
    const accessToken = await this.tokens.signAccessToken({
      sub: identity.id,
      email: identity.email,
      role: identity.role,
      companyId: identity.companyId,
    });

    const { token: refreshToken, jti } = await this.tokens.signRefreshToken(identity.id);
    await this.refreshStore.register(identity.id, jti, this.tokens.refreshTtlSeconds());

    return { accessToken, refreshToken };
  }
}
