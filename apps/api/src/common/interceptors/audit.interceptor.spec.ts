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
    // M2.10 — a public route must state its tenant; an authenticated one
    // inherits the actor's. Set here so the PUBLIC cases below are valid.
    auditCompanyId: 'company-1',
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

  /**
   * A request can be more than one auditable event (Handoff §I: a move into
   * Hired is both `application.stage_changed` and `application.hired`).
   */
  describe('additional audit records', () => {
    it('writes extras after the declared action, in order', (done) => {
      markAuditable({ action: 'application.stage_changed', resourceType: 'application' });
      const { context } = makeContext({
        auditExtra: [{ action: 'application.hired' }],
      });

      interceptor.intercept(context, next).subscribe(() => {
        expect(auditService.record).toHaveBeenCalledTimes(2);
        expect(auditService.record.mock.calls[0]?.[0]).toMatchObject({
          action: 'application.stage_changed',
        });
        expect(auditService.record.mock.calls[1]?.[0]).toMatchObject({
          action: 'application.hired',
        });
        done();
      });
    });

    it('an extra inherits resourceType, resourceId, actor and correlation id', (done) => {
      markAuditable({ action: 'application.stage_changed', resourceType: 'application' });
      const { context } = makeContext({ auditExtra: [{ action: 'application.rejected' }] });

      interceptor.intercept(context, next).subscribe(() => {
        expect(auditService.record).toHaveBeenLastCalledWith(
          expect.objectContaining({
            action: 'application.rejected',
            resourceType: 'application',
            resourceId: 'resource-1',
            actorId: 'user-1',
            actorType: AuditActorType.USER,
            correlationId: 'corr-1',
          }),
        );
        done();
      });
    });

    it('an extra may override its own resource and carry its own state', (done) => {
      markAuditable({ action: 'application.stage_changed', resourceType: 'application' });
      const { context } = makeContext({
        auditExtra: [
          {
            action: 'application.hired',
            resourceType: 'candidate',
            resourceId: 'other-id',
            before: { currentStage: 'Offer' },
            after: { currentStage: 'Hired' },
          },
        ],
      });

      interceptor.intercept(context, next).subscribe(() => {
        expect(auditService.record).toHaveBeenLastCalledWith(
          expect.objectContaining({
            resourceType: 'candidate',
            resourceId: 'other-id',
            beforeState: { currentStage: 'Offer' },
            afterState: { currentStage: 'Hired' },
          }),
        );
        done();
      });
    });

    it('fails the request if an EXTRA write fails — BR-03 applies to all of them', (done) => {
      markAuditable({ action: 'application.stage_changed', resourceType: 'application' });
      const { context } = makeContext({ auditExtra: [{ action: 'application.hired' }] });

      auditService.record
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('db down'));

      interceptor.intercept(context, next).subscribe({
        next: () => done.fail('response must not be emitted when auditing fails'),
        error: (err: Error) => {
          expect(err.message).toBe('db down');
          done();
        },
      });
    });

    /**
     * `auditSuppressed` skips the DECLARED record only. A bulk action has no
     * single resource to name, so it suppresses the declared record and
     * supplies one record per candidate instead — those must still be written.
     */
    it('suppression skips the declared record but keeps the extras', (done) => {
      markAuditable({ action: 'application.stage_changed', resourceType: 'application' });
      const { context } = makeContext({
        auditSuppressed: true,
        auditExtra: [
          { action: 'application.stage_changed', resourceId: 'app-1' },
          { action: 'application.rejected', resourceId: 'app-1' },
        ],
      });

      interceptor.intercept(context, next).subscribe(() => {
        expect(auditService.record).toHaveBeenCalledTimes(2);
        expect(auditService.record.mock.calls.every((call) => call[0].resourceId === 'app-1')).toBe(
          true,
        );
        done();
      });
    });

    it('suppression with no extras writes nothing — the no-op case', (done) => {
      markAuditable({ action: 'application.stage_changed', resourceType: 'application' });
      const { context } = makeContext({ auditSuppressed: true });

      interceptor.intercept(context, next).subscribe(() => {
        expect(auditService.record).not.toHaveBeenCalled();
        done();
      });
    });

    /**
     * A bulk route has no :id, so an extra that names no resource of its own
     * cannot be written anywhere meaningful. Failing loudly beats a row that
     * points nowhere.
     */
    it('throws if an extra has no resource id and the route provides none', (done) => {
      markAuditable({ action: 'application.stage_changed', resourceType: 'application' });
      const { context } = makeContext({
        params: {},
        auditSuppressed: true,
        auditExtra: [{ action: 'application.hired' }],
      });

      // A bulk response carries per-item results, not a single `id`, so there
      // is nothing for the interceptor to fall back on.
      const bulkNext: CallHandler = { handle: () => of({ succeeded: [], failed: [] }) };

      interceptor.intercept(context, bulkNext).subscribe({
        next: () => done.fail('expected an error'),
        error: (err: Error) => {
          expect(err.message).toContain('could not determine a resource id');
          done();
        },
      });
    });

    it('writes only the declared action when there are no extras', (done) => {
      markAuditable({ action: 'application.stage_changed', resourceType: 'application' });
      const { context } = makeContext();

      interceptor.intercept(context, next).subscribe(() => {
        expect(auditService.record).toHaveBeenCalledTimes(1);
        done();
      });
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
