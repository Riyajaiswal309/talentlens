import { useQuery } from '@tanstack/react-query';
import { api, apiDownload } from '../../lib/api-client';

/**
 * FR8.3 — the audit log: "a complete, exportable audit log records all user
 * actions and AI-influenced decisions".
 *
 * READ-ONLY BY CONSTRUCTION. `audit_logs` holds INSERT and SELECT grants only
 * (the migration REVOKEs UPDATE and DELETE, and the API connects as a
 * restricted role so a table owner cannot bypass it). There is no edit path to
 * build here even if one were wanted.
 */

/**
 * The action vocabulary, mirroring `AUDIT_ACTIONS` on the server.
 *
 * `QueryAuditDto` validates `actionType` with `@IsIn(AUDIT_ACTIONS)`, so an
 * invented value is a 400 — the filter cannot offer more than the API accepts.
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
  'application.source_changed',
  'application.tagged',
  'application.untagged',
  'score.overridden',
  'score.generated',
  'job.ranking_weights_changed',
  'parsed_profile.corrected',
  'calendar.connected',
  'calendar.disconnected',
  'admin.ai_scoring_changed',
  'admin.role_changed',
  'admin.user_invited',
  'audit.exported',
  'candidate.erased',
] as const;

export interface AuditRow {
  id: string;
  createdAt: string;
  actorId: string | null;
  /** Denormalised so the table shows who acted rather than an opaque uuid. */
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
}

interface AuditListResponse {
  data: AuditRow[];
  nextCursor: string | null;
  /**
   * The audit list is the ONE endpoint that returns a total.
   * Everything else in the API is cursor-paginated with no count (§23.1), so
   * this figure is shown here and nowhere else.
   */
  totalCount: number;
}

export interface AuditFilters {
  actionType?: string;
  from?: string;
  to?: string;
}

export const AUDIT_PAGE_SIZE = 50;

export function useAuditLog(filters: AuditFilters, cursor?: string) {
  return useQuery({
    queryKey: [
      'audit',
      filters.actionType ?? null,
      filters.from ?? null,
      filters.to ?? null,
      cursor ?? null,
    ],
    queryFn: ({ signal }) =>
      api.get<AuditListResponse>('/audit-logs', {
        query: {
          actionType: filters.actionType,
          from: filters.from,
          to: filters.to,
          cursor,
          limit: AUDIT_PAGE_SIZE,
        },
        signal,
      }),
  });
}

/**
 * FR8.3 — download the export of `GET /v1/audit-logs/export`.
 *
 * NOT A PLAIN `<a href>`. The access token lives in memory and travels as an
 * `Authorization` header; the only cookie is the refresh token, scoped
 * `Path=/v1/auth`, so it is never sent here. A bare link would arrive
 * unauthenticated and answer 401, and putting the token in the query string
 * would leak it into history and logs. `apiDownload` makes the normal
 * authenticated request and turns the streamed response into a file.
 *
 * The same filters the table is showing are applied, so the export matches
 * what the administrator is looking at rather than silently exporting
 * everything.
 */
export function downloadAuditExport(filters: AuditFilters, format: 'csv' | 'json'): Promise<void> {
  return apiDownload('/audit-logs/export', `talentlens-audit-log.${format}`, {
    query: {
      format,
      actionType: filters.actionType,
      from: filters.from,
      to: filters.to,
    },
  });
}

/** `application.stage_changed` is a stored constant, not a sentence. */
export function formatAction(action: string): string {
  const [group, ...rest] = action.split('.');
  const verb = rest.join('.').replace(/_/g, ' ');
  return `${group![0]!.toUpperCase()}${group!.slice(1)} · ${verb}`;
}
