import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditActorType } from '@prisma/client';
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
        /*
         * A handler may declare that it changed nothing — an idempotent
         * replay returns the original response without touching a row. PRD
         * §17.3 records state changes, so writing a second record here would
         * make the trail claim an event that did not happen.
         *
         * Checked AFTER the handler runs, never before: the handler is what
         * decides, and a route cannot opt out of auditing in advance (BR-03).
         */
        if (request.auditSuppressed) return responseBody;

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
     * APPROVED RESOLUTION of the audit-actor PRD GAP (8 Aug 2026).
     *
     * Handoff §I requires `application.submitted` (FR2.1) to be audited, but
     * POST /v1/applications is Public — an unauthenticated candidate with no
     * users row. Rather than invent a synthetic system user, the record now
     * carries a discriminator:
     *
     *   USER   — authenticated action, actor_id present
     *   PUBLIC — unauthenticated action, actor_id NULL
     *
     * A public auditable action is therefore RECORDED, not skipped. The
     * pairing is enforced by a database CHECK constraint, so a row can never
     * claim an actor it does not have.
     */
    const actorType = actor ? AuditActorType.USER : AuditActorType.PUBLIC;
    const actorId = actor?.id ?? null;

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
      actorId,
      actorType,
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
