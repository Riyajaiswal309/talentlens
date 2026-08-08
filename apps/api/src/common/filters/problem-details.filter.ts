import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { CORRELATION_ID_HEADER } from '../interceptors/correlation-id.interceptor';
import type { RequestContext } from '../types/authenticated-request';

/**
 * RFC 7807 problem+json error responses (PRD §23.1).
 *
 * Required shape: type, title, status, detail, instance.
 *
 * Phase 1 §10.5 additionally requires that error text "names the problem AND
 * the fix" — that wording lives in the messages handlers throw; this filter
 * guarantees the envelope carries it in `detail` rather than discarding it.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  /** NFR11 — lets a user quote one id when reporting a failure. */
  correlationId?: string;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestContext>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const { title, detail } = this.describe(exception, status);

    // 5xx means we failed, not the caller — log it with the correlation id so
    // the trace can be followed (NFR11). 4xx is expected traffic.
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} [${request.correlationId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      detail,
      instance: request.url,
      correlationId: request.correlationId,
    };

    response
      .status(status)
      .type('application/problem+json')
      .setHeader(CORRELATION_ID_HEADER, request.correlationId ?? '')
      .json(body);
  }

  private describe(exception: unknown, status: number): { title: string; detail: string } {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        return { title: statusTitle(status), detail: payload };
      }

      if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        const message = record['message'];

        // ValidationPipe returns message as string[]; join so nothing is lost.
        const detail = Array.isArray(message)
          ? message.join('; ')
          : typeof message === 'string'
            ? message
            : exception.message;

        const title = typeof record['error'] === 'string' ? record['error'] : statusTitle(status);
        return { title, detail };
      }
    }

    // Never leak internals of an unexpected error to the client. The stack is
    // logged above; the caller gets the correlation id to quote instead.
    return {
      title: statusTitle(status),
      detail: 'An unexpected error occurred. Quote the correlation ID when reporting this.',
    };
  }
}

function statusTitle(status: number): string {
  const titles: Record<number, string> = {
    [HttpStatus.BAD_REQUEST]: 'Bad Request',
    [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
    [HttpStatus.FORBIDDEN]: 'Forbidden',
    [HttpStatus.NOT_FOUND]: 'Not Found',
    [HttpStatus.METHOD_NOT_ALLOWED]: 'Method Not Allowed',
    [HttpStatus.CONFLICT]: 'Conflict',
    [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
    [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
    [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
  };
  return titles[status] ?? 'Error';
}
