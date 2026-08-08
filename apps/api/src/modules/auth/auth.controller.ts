import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { AuthService, type AuthenticatedIdentity } from './auth.service';
import { TokenService } from './token.service';
import { LoginDto } from './dto/login.dto';

/**
 * PRD §24.1 — the refresh token is delivered as an httpOnly cookie so page
 * JavaScript cannot read it. `secure` is disabled outside production only
 * because localhost is plain HTTP; PRD §24.3 mandates TLS everywhere else.
 */
const REFRESH_COOKIE = 'refresh_token';

function refreshCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/v1/auth',
    maxAge: maxAgeSeconds * 1000,
  };
}

/** Shape returned to clients. Never contains a hash or a refresh token. */
interface IdentityResponse {
  id: string;
  email: string;
  role: string;
  companyId: string;
}

function toIdentityResponse(identity: AuthenticatedIdentity | AuthenticatedUser): IdentityResponse {
  return {
    id: identity.id,
    email: identity.email,
    role: identity.role,
    companyId: identity.companyId,
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  /** POST /v1/auth/login — Public (Handoff §B row 1). */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; user: IdentityResponse }> {
    const { identity, accessToken, refreshToken } = await this.auth.login(dto.email, dto.password);

    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(this.tokens.refreshTtlSeconds()));

    // The refresh token is returned ONLY in the httpOnly cookie, never in the
    // body, so that XSS cannot exfiltrate it.
    return { accessToken, user: toIdentityResponse(identity) };
  }

  /** POST /v1/auth/refresh — authenticated by the refresh cookie (Handoff §B row 2). */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; user: IdentityResponse }> {
    const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;

    const { identity, accessToken, refreshToken } = await this.auth.refresh(presented ?? '');

    // Rotation: overwrite the cookie so the consumed token cannot be resent.
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(this.tokens.refreshTtlSeconds()));

    return { accessToken, user: toIdentityResponse(identity) };
  }

  /** POST /v1/auth/logout — Authenticated (Handoff §B row 3). */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    res.clearCookie(REFRESH_COOKIE, { path: '/v1/auth' });
  }

  /**
   * GET /v1/auth/me — Authenticated (Handoff §B row 4).
   *
   * Returns the principal the server derived from the access token, which is
   * how the frontend bootstraps its session on reload.
   */
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser | undefined): IdentityResponse {
    // JwtAuthGuard guarantees a principal here; the check satisfies the
    // compiler rather than guarding a real case.
    if (!user) throw new Error('JwtAuthGuard did not populate the request context');
    return toIdentityResponse(user);
  }
}
