import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit';

export interface AuditMetadata {
  /** Dotted action name, e.g. 'job.published' (Handoff §I Table I.1). */
  action: string;
  /** Entity the action targets, e.g. 'job', 'application'. */
  resourceType: string;
  /** Route param holding the resource id. Defaults to 'id'. */
  resourceIdParam?: string;
}

/**
 * Marks a route as auditable (PRD FR8.3, BR-03).
 *
 * Routes without this decorator are not audited. That is deliberate: reads do
 * not need an audit record, and marking each mutating route explicitly keeps
 * the action vocabulary aligned with Handoff §I rather than derived from URLs.
 */
export const Audit = (metadata: AuditMetadata) => SetMetadata(AUDIT_KEY, metadata);
