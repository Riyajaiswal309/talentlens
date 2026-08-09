/**
 * AI-related entries in the Handoff §I audit vocabulary.
 *
 * Defined here rather than inline so the action strings have one source and
 * cannot drift into near-misses ('score.override' vs 'score.overridden')
 * that would quietly split the audit trail in two.
 */
export const AI_AUDIT_ACTIONS = {
  /**
   * FR4.4 — an AI score was persisted.
   *
   * Handoff §I: "hook wired, never fires in P2". Phase 2 runs no model, so
   * nothing generates a score and nothing emits this. The constant and the
   * AuditService write path both exist so Phase 3 adds a caller rather than
   * a mechanism; a test proves the record can be written, and another proves
   * no production code writes one.
   */
  SCORE_GENERATED: 'score.generated',

  /**
   * FR4.3 / BR-03 — a recruiter overrode a score. The record must carry the
   * reason, which is why the endpoint requires one.
   */
  SCORE_OVERRIDDEN: 'score.overridden',
} as const;

export type AiAuditAction = (typeof AI_AUDIT_ACTIONS)[keyof typeof AI_AUDIT_ACTIONS];
