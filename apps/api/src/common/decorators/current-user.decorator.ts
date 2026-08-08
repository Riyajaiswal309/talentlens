import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, RequestContext } from '../types/authenticated-request';

/** Injects the authenticated principal. Populated by AuthModule in M2.4. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined => {
    const request = ctx.switchToHttp().getRequest<RequestContext>();
    return request.user;
  },
);
