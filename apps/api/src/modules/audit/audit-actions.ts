import { AI_AUDIT_ACTIONS } from '../ai/ai-audit-actions';

/**
 * The complete audit vocabulary (Handoff §I Table I.1).
 *
 * Gap 4 validation rule 2: "`actionType` must be a known action string;
 * unknown values return 400 rather than silently matching nothing." A filter
 * that quietly returns an empty page is worse than an error — an auditor
 * would read "no such events" where the truth is "you misspelled it".
 *
 * The list must therefore be a SUPERSET of everything the system emits: an
 * action that is written but not listed here would be unfilterable, and the
 * 400 would be lying in the other direction. A test walks the source tree to
 * keep the two in step.
 *
 * It may legitimately be broader. Some entries name events whose feature is
 * not built yet (auth.login_*, candidate.erased, job.closed); listing them
 * costs nothing and means the vocabulary does not shift when they arrive.
 */
export const AUDIT_ACTIONS = [
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.sessions_revoked',
  'job.created',
  'job.updated',
  'job.published',
  'job.closed',
  'job.duplicated',
  'application.submitted',
  'application.stage_changed',
  'application.hired',
  'application.rejected',
  AI_AUDIT_ACTIONS.SCORE_OVERRIDDEN,
  AI_AUDIT_ACTIONS.SCORE_GENERATED,
  // Phase 3 integration.
  'job.ranking_weights_changed',
  'parsed_profile.corrected',
  // FR7.3 — a correction to source-of-hire. The initial capture rides inside
  // `application.submitted`; this records a later change, which alters a
  // reported business metric (amendment C3).
  'application.source_changed',
  // FR6.1 — calendar connection lifecycle (amendments C4, D43). State carries
  // provider and account_identifier only; never credential material.
  // `calendar.connected` is listed but not yet emitted: it belongs to the
  // provider OAuth adapter, which is not built. The vocabulary is allowed to
  // be broader than what is emitted; the reverse would make a real event
  // unfilterable.
  'calendar.connected',
  'calendar.disconnected',
  'admin.ai_scoring_changed',
  'admin.role_changed',
  'admin.user_invited',
  'audit.exported',
  'candidate.erased',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const KNOWN = new Set<string>(AUDIT_ACTIONS);

export function isKnownAction(value: string): value is AuditAction {
  return KNOWN.has(value);
}

/**
 * The export's own event, excluded from exports.
 *
 * Without this, every export would include the record of itself being run,
 * and an export of an export would compound — the file would grow a tail of
 * bookkeeping that says nothing about the hiring activity being audited.
 */
export const EXPORT_ACTION = 'audit.exported';
