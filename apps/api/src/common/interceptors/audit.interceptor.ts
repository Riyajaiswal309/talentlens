import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { concatMap, type Observable } from 'rxjs';
import { AUDIT_KEY, type AuditMetadata } from '../decorators/audit.decorator';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../types/authenticated-request';

/**
 * Writes an audit record for every route marked with @Audit().
 *
 * ORDERING IS THE POINT (PRD §15.1 principle 4, BR-03):
 * "An audit record is committed BEFORE the originating request returns
 *  success — logging is synchronous and non-optional."
 *
 * This is why the write uses `concatMap` rather than `tap`. `tap` would fire
 * the write and let the response continue without waiting, so a client could
 * be told an override succeeded before its reason was durably recorded.
 * `concatMap` awaits the returned promise, so the response is emitted only
 * after the audit row is committed. If the write throws, the error propagates
 * and the request fails — which is the required behaviour, not a bug.
 *
 * Handlers supply before/after state by assigning to `request.auditState`.
 * The interceptor cannot fetch prior state generically: only the handler
 * knows which entity it is about to change.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.getAllAndOverride<AuditMetadata | undefined>(AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Not marked auditable — reads, health checks, and anything else.
    if (!metadata) return next.handle();

    const request = context.switchToHttp().getRequest<RequestContext>();

    return next.handle().pipe(
      concatMap(async (responseBody: unknown) => {
        await this.write(metadata, request, responseBody);
        return responseBody;
      }),
    );
  }

  private async write(
    metadata: AuditMetadata,
    request: RequestContext,
    responseBody: unknown,
  ): Promise<void> {
    const actor = request.user;

    /*
     * PRD GAP — REQUIRES DECISION.
     *
     * audit_logs.actor_id is NOT NULL REFERENCES users(id) (PRD §17.3), but
     * Handoff §I requires `application.submitted` (FR2.1) to be audited and
     * POST /v1/applications is PUBLIC — an unauthenticated candidate. A public
     * action that must be audited therefore cannot be, because it has no
     * users row to reference.
     *
     * Not resolved here. Inventing a synthetic "system" user or making the
     * column nullable would both be schema/product decisions, not
     * implementation details. Until it is decided, unauthenticated auditable
     * actions are logged as a warning and skipped rather than silently
     * dropped. No such route exists yet, so nothing is currently missed.
     */
    if (!actor) {
      this.logger.warn(
        `Auditable action '${metadata.action}' had no authenticated actor and was NOT recorded. ` +
          'See PRD GAP: audit_logs.actor_id is NOT NULL but some audited actions are public.',
      );
      return;
    }

    const correlationId = request.correlationId;
    if (!correlationId) {
      // CorrelationIdInterceptor must run first (NFR11). If it did not, the
      // registration order is wrong and traceability is broken — fail loudly.
      throw new Error(
        'AuditInterceptor ran without a correlation ID. ' +
          'CorrelationIdInterceptor must be registered before AuditInterceptor.',
      );
    }

    const resourceId =
      readParam(request, metadata.resourceIdParam ?? 'id') ?? extractId(responseBody);

    if (!resourceId) {
      throw new Error(
        `Auditable action '${metadata.action}' could not determine a resource id. ` +
          'Provide resourceIdParam on @Audit() or return an object containing an id.',
      );
    }

    await this.auditService.record({
      actorId: actor.id,
      action: metadata.action,
      resourceType: metadata.resourceType,
      resourceId,
      correlationId,
      beforeState: request.auditState?.before ?? null,
      afterState: request.auditState?.after ?? null,
    });
  }
}

/**
 * Express types route params as `string | string[]` because wildcard segments
 * can repeat. An audit resource id is always a single value, so an array is a
 * routing mistake rather than something to coerce — ignore it and let the
 * caller fall back to the response body or fail loudly.
 */
function readParam(request: RequestContext, name: string): string | undefined {
  const value = request.params?.[name];
  return typeof value === 'string' ? value : undefined;
}

function extractId(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'id' in body) {
    const id = (body as { id: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}
