import { AI_AUDIT_ACTIONS } from '../ai/ai-audit-actions';

/**
 * The complete audit vocabulary (Handoff §I Table I.1).
 *
 * Gap 4 validation rule 2: "`actionType` must be a known action string;
 * unknown values return 400 rather than silently matching nothing." A filter
 * that quietly returns an empty page is worse than an error — an auditor
 * would read "no such events" where the truth is "you misspelled it".
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
