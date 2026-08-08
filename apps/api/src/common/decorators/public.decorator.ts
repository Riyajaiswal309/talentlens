import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * Authentication is DENY BY DEFAULT: JwtAuthGuard rejects any request without
 * a valid access token unless the route opts out here. Forgetting @Public()
 * makes a route unreachable, which is a loud, safe failure; forgetting the
 * opposite would silently expose data.
 *
 * PRD §23.2 marks these Public: POST /v1/auth/login, POST /v1/applications,
 * GET /v1/public/jobs.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
