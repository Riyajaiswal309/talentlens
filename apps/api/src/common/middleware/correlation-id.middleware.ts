import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import {
  CORRELATION_ID_HEADER,
  resolveCorrelationId,
} from '../interceptors/correlation-id.interceptor';
import type { RequestContext } from '../types/authenticated-request';

/**
 * Assigns the correlation id BEFORE routing (PRD NFR11).
 *
 * Why this exists alongside CorrelationIdInterceptor: NestJS does not run
 * interceptors when no route matches, so a 404 would come back with no id and
 * a user reporting "I got a 404" would have nothing to quote. NFR11 says
 * *every* request is traceable, and an unmatched request is still a request.
 *
 * Middleware runs earlier in the Express pipeline, so it covers unmatched
 * routes too. The interceptor remains the authority for matched routes and
 * simply preserves whatever this already set.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: RequestContext, res: Response, next: NextFunction): void {
    const correlationId = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
    req.correlationId = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    next();
  }
}
