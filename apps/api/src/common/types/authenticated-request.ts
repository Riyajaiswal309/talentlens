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

export interface RequestContext extends Request {
  user?: AuthenticatedUser;
  /** PRD NFR11 — set by CorrelationIdInterceptor on every request. */
  correlationId?: string;
  /** Populated by handlers on auditable routes. */
  auditState?: AuditState;
}
