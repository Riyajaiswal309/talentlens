import { Reflector } from '@nestjs/core';
import { AuditActorType, UserRole } from '@prisma/client';
import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { AuditInterceptor } from './audit.interceptor';
import type { AuditMetadata } from '../decorators/audit.decorator';
import type { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../types/authenticated-request';

function makeContext(overrides: Partial<RequestContext> = {}) {
  const request = {
    params: { id: 'resource-1' },
    correlationId: 'corr-1',
    user: {
      id: 'user-1',
      role: UserRole.RECRUITER,
      companyId: 'company-1',
      email: 'r@example.com',
    },
    ...overrides,
  } as unknown as RequestContext;

  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;

  return { request, context };
}

describe('AuditInterceptor (BR-03, PRD §15.1 principle 4)', () => {
  let reflector: Reflector;
  let auditService: { record: jest.Mock };
  let interceptor: AuditInterceptor;

  beforeEach(() => {
    reflector = new Reflector();
    auditService = { record: jest.fn().mockResolvedValue(undefined) };
    interceptor = new AuditInterceptor(reflector, auditService as unknown as AuditService);
  });

  function markAuditable(metadata: AuditMetadata | undefined) {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(metadata);
  }

  const next: CallHandler = { handle: () => of({ id: 'resource-1', ok: true }) };

  it('does not audit routes without @Audit()', (done) => {
    markAuditable(undefined);
    const { context } = makeContext();

    interceptor.intercept(context, next).subscribe(() => {
      expect(auditService.record).not.toHaveBeenCalled();
      done();
    });
  });

  it('records action, resource, actor and correlation id', (done) => {
    markAuditable({ action: 'job.published', resourceType: 'job' });
    const { context } = makeContext();

    interceptor.intercept(context, next).subscribe(() => {
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'user-1',
          actorType: AuditActorType.USER,
          action: 'job.published',
          resourceType: 'job',
          resourceId: 'resource-1',
          correlationId: 'corr-1',
        }),
      );
      done();
    });
  });

  it('BR-03: passes through before/after state supplied by the handler', (done) => {
    markAuditable({ action: 'score.overridden', resourceType: 'match_score' });
    const { context } = makeContext({
      auditState: { before: { composite: 0.42 }, after: { composite: 0.95 } },
    });

    interceptor.intercept(context, next).subscribe(() => {
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          beforeState: { composite: 0.42 },
          afterState: { composite: 0.95 },
        }),
      );
      done();
    });
  });

  /**
   * The ordering guarantee, tested directly.
   *
   * PRD §15.1 principle 4 requires the audit record to be committed BEFORE
   * the response is acknowledged. If this were implemented with `tap` instead
   * of `concatMap`, the response would be emitted while the write was still
   * in flight and this test would fail.
   */
  it('PRD §15.1: commits the audit record BEFORE emitting the response', (done) => {
    markAuditable({ action: 'job.published', resourceType: 'job' });
    const { context } = makeContext();

    const order: string[] = [];
    auditService.record.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            order.push('audit-written');
            resolve();
          }, 20),
        ),
    );

    interceptor.intercept(context, next).subscribe(() => {
      order.push('response-emitted');
      expect(order).toEqual(['audit-written', 'response-emitted']);
      done();
    });
  });

  it('fails the request when the audit write fails — never silently unaudited', (done) => {
    markAuditable({ action: 'job.published', resourceType: 'job' });
    const { context } = makeContext();
    auditService.record.mockRejectedValue(new Error('db down'));

    interceptor.intercept(context, next).subscribe({
      next: () => done.fail('response must not be emitted when auditing fails'),
      error: (err: Error) => {
        expect(err.message).toBe('db down');
        done();
      },
    });
  });

  it('throws if CorrelationIdInterceptor did not run first (NFR11)', (done) => {
    markAuditable({ action: 'job.published', resourceType: 'job' });
    const { context } = makeContext({ correlationId: undefined });

    interceptor.intercept(context, next).subscribe({
      next: () => done.fail('expected an error'),
      error: (err: Error) => {
        expect(err.message).toContain('correlation ID');
        done();
      },
    });
  });

  /**
   * APPROVED RESOLUTION of the audit-actor PRD GAP (8 Aug 2026).
   *
   * This test was previously inverted: it asserted that a public auditable
   * action was SKIPPED, because audit_logs.actor_id was NOT NULL and no row
   * could be written. With actor_type in place, the action is now RECORDED as
   * PUBLIC with a null actor. FR2.1's `application.submitted` on the public
   * POST /v1/applications depends on exactly this.
   */
  it('records a public auditable action as PUBLIC with a null actor', (done) => {
    markAuditable({ action: 'application.submitted', resourceType: 'application' });
    const { context } = makeContext({ user: undefined });

    interceptor.intercept(context, next).subscribe(() => {
      expect(auditService.record).toHaveBeenCalledTimes(1);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: null,
          actorType: AuditActorType.PUBLIC,
          action: 'application.submitted',
          resourceType: 'application',
        }),
      );
      done();
    });
  });

  it('a public auditable action still fails the request if its audit write fails', (done) => {
    markAuditable({ action: 'application.submitted', resourceType: 'application' });
    const { context } = makeContext({ user: undefined });
    auditService.record.mockRejectedValue(new Error('db down'));

    // BR-03 applies regardless of who the actor is: an unaudited submission
    // must not be acknowledged as successful.
    interceptor.intercept(context, next).subscribe({
      next: () => done.fail('response must not be emitted when auditing fails'),
      error: (err: Error) => {
        expect(err.message).toBe('db down');
        done();
      },
    });
  });

  it('still requires a correlation id for a public action (NFR11)', (done) => {
    markAuditable({ action: 'application.submitted', resourceType: 'application' });
    const { context } = makeContext({ user: undefined, correlationId: undefined });

    interceptor.intercept(context, next).subscribe({
      next: () => done.fail('expected an error'),
      error: (err: Error) => {
        expect(err.message).toContain('correlation ID');
        done();
      },
    });
  });
});
