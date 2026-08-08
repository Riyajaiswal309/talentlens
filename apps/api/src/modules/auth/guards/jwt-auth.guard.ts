import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import type { RequestContext } from '../../../common/types/authenticated-request';
import { TokenService } from '../token.service';

/**
 * Verifies the access token and populates the request context.
 *
 * DENY BY DEFAULT: every route requires a valid access token unless marked
 * @Public(). Runs before RolesGuard and TenantGuard, which read the principal
 * this guard attaches.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestContext>();
    const token = extractBearer(request.headers.authorization);

    if (!token) throw new UnauthorizedException('Authentication required');

    const claims = await this.tokens.verifyAccessToken(token);
    if (!claims) throw new UnauthorizedException('Access token is invalid or expired');

    // PRD NFR6 — downstream guards and handlers read role and tenant from
    // here, never from anything the client can set directly.
    request.user = {
      id: claims.sub,
      email: claims.email,
      role: claims.role,
      companyId: claims.companyId,
    };

    return true;
  }
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return undefined;
  return value.trim() || undefined;
}
