import type { Request } from 'express';
import type { Prisma, UserRole } from '@prisma/client';

/**
 * The authenticated principal attached to a request.
 *
 * M2.3 defines the SHAPE only. Nothing populates it yet — AuthModule (M2.4)
 * is what will attach it after verifying the JWT. Guards and interceptors
 * here read it defensively so they behave correctly both before and after
 * authentication exists.
 */
export interface AuthenticatedUser {
  id: string;
  /** PRD §24.2 — drives RolesGuard. */
  role: UserRole;
  /** PRD BR-06 / risk R-09 — drives TenantGuard scoping. */
  companyId: string;
  email: string;
}

/**
 * Before/after snapshots for the audit trail (PRD §17.3 audit_logs).
 *
 * Handlers populate this; AuditInterceptor reads it. The interceptor cannot
 * capture `before` generically — only the handler knows which row it is about
 * to change, and reading it back afterwards would be too late.
 */
export interface AuditState {
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
}

/**
 * An audit record written IN ADDITION to the one @Audit() declares.
 *
 * Exists because a single request can be more than one auditable event.
 * Handoff §I lists `application.stage_changed` for every transition AND
 * `application.hired` / `application.rejected` for a terminal decision, so a
 * move into Hired is both — recording only one would lose an event the audit
 * vocabulary names explicitly.
 *
 * `resourceType` and `resourceId` default to the ones @Audit() resolved.
 */
export interface AdditionalAudit {
  action: string;
  resourceType?: string;
  resourceId?: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
}

export interface RequestContext extends Request {
  user?: AuthenticatedUser;
  /** PRD NFR11 — set by CorrelationIdInterceptor on every request. */
  correlationId?: string;
  /** Populated by handlers on auditable routes. */
  auditState?: AuditState;
  /**
   * Set by a handler that changed NOTHING, so @Audit() writes no record.
   *
   * PRD §17.3 audits actions that change state. An idempotent replay returns
   * the original response without touching a row, so auditing it again would
   * put two `application.submitted` records against one application and make
   * the trail overstate what happened.
   *
   * Deliberately narrow: it suppresses the record only when the handler
   * asserts there was no state change. It is not a way to opt a mutating
   * route out of auditing, which BR-03 forbids.
   */
  auditSuppressed?: boolean;
  /**
   * Extra audit records for a request that is more than one event.
   *
   * Written by AuditInterceptor after the record @Audit() declares, so all
   * of them are committed before the response is emitted (PRD §15.1
   * principle 4). Ignored when `auditSuppressed` is set — a handler that
   * changed nothing has no events at all.
   */
  auditExtra?: AdditionalAudit[];
}
