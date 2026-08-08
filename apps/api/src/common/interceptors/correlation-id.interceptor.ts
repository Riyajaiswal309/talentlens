import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Observable } from 'rxjs';
import type { Response } from 'express';
import type { RequestContext } from '../types/authenticated-request';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Accepts an inbound id when usable, generates one otherwise.
 * Shared with CorrelationIdMiddleware so both paths behave identically.
 */
export function resolveCorrelationId(inbound: string | string[] | undefined): string {
  if (typeof inbound === 'string' && inbound.trim().length > 0) return inbound.trim();
  return randomUUID();
}

/**
 * PRD NFR11 — "Every request traceable end-to-end by correlation ID,
 * including across asynchronous processing."
 *
 * Accepts an inbound id so a trace spanning several services stays joined,
 * and generates one otherwise. The id is echoed on the response so a client
 * (or a support ticket) can quote it, and is stamped onto every audit record.
 *
 * Runs first: AuditInterceptor depends on the id already being present.
 *
 * CorrelationIdMiddleware normally assigns the id before routing (so that
 * unmatched routes are traceable too). This interceptor preserves whatever
 * the middleware set and only generates one if it is missing — which keeps it
 * correct in unit tests and any non-HTTP execution context.
 */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestContext>();
    const response = http.getResponse<Response>();

    const correlationId =
      request.correlationId ?? resolveCorrelationId(request.headers[CORRELATION_ID_HEADER]);

    request.correlationId = correlationId;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);

    return next.handle();
  }
}
