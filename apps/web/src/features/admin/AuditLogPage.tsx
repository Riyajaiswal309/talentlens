import { useId, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, SkeletonTable } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { Badge, Card, PageHeader, buttonClass } from '../../components/ui';
import { isApiError } from '../../lib/problem-details';
import {
  AUDIT_ACTIONS,
  downloadAuditExport,
  formatAction,
  useAuditLog,
  type AuditFilters,
  type AuditRow,
} from './useAudit';
import { formatDateTime } from './useAdmin';

/**
 * FR8.3 — the audit log, Administrator only.
 *
 * "A complete, exportable audit log records all user actions and AI-influenced
 * decisions." Both halves are here: the table reads `GET /v1/audit-logs`, and
 * the export buttons stream `GET /v1/audit-logs/export` with the SAME filters,
 * so an administrator exports what they are looking at.
 *
 * THE TOTAL IS REAL. This is the one endpoint in the API that returns a count
 * (`totalCount`); every other list is cursor-paginated with no total (§23.1).
 * It is shown here and nowhere else, because here it is a figure the server
 * actually stated.
 */
export function AuditLogPage() {
  const [actionType, setActionType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null);
  const [exportError, setExportError] = useState<unknown>(null);
  const { notify } = useToast();

  const actionId = useId();
  const fromId = useId();
  const toId = useId();

  const filters: AuditFilters = {
    ...(actionType ? { actionType } : {}),
    // A date input yields YYYY-MM-DD; the DTO validates ISO 8601. `from` opens
    // the day and `to` closes it so a single-day range covers that whole day.
    ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
    ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
  };
  const filtersActive = Boolean(actionType || from || to);

  const query = useAuditLog(filters, cursor);

  function changeFilter(apply: () => void) {
    apply();
    // A filter change invalidates the cursor: page 3 of the old result set is
    // meaningless in the new one.
    setCursor(undefined);
  }

  async function onExport(format: 'csv' | 'json') {
    setExporting(format);
    setExportError(null);
    try {
      await downloadAuditExport(filters, format);
      notify(`Audit log exported as ${format.toUpperCase()}.`);
    } catch (error) {
      // Surfaced inline and kept, rather than thrown away into a toast.
      setExportError(error);
    } finally {
      setExporting(null);
    }
  }

  return (
    <div>
      <PageHeader
        code="ADMIN"
        title="Audit log"
        description="Every recorded action in your company. Append-only — entries cannot be edited or deleted."
        actions={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void onExport('csv')}
              disabled={exporting !== null}
              aria-disabled={exporting !== null}
              className={buttonClass('secondary')}
            >
              {exporting === 'csv' ? 'Exporting…' : 'Export CSV'}
            </button>
            <button
              type="button"
              onClick={() => void onExport('json')}
              disabled={exporting !== null}
              aria-disabled={exporting !== null}
              className={buttonClass('secondary')}
            >
              {exporting === 'json' ? 'Exporting…' : 'Export JSON'}
            </button>
          </div>
        }
      />

      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label
              htmlFor={actionId}
              className="mb-1.5 block text-xs font-semibold text-neutral-700"
            >
              Action
            </label>
            {/* Exactly `AUDIT_ACTIONS`. `QueryAuditDto` validates with @IsIn,
                so any other value would be a guaranteed 400. */}
            <select
              id={actionId}
              value={actionType}
              onChange={(event) => changeFilter(() => setActionType(event.target.value))}
              className="h-10 w-64 rounded-md border border-neutral-300 bg-neutral-0 px-3 text-sm text-neutral-900 transition-colors hover:border-neutral-400"
            >
              <option value="">All actions</option>
              {AUDIT_ACTIONS.map((value) => (
                <option key={value} value={value}>
                  {formatAction(value)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor={fromId} className="mb-1.5 block text-xs font-semibold text-neutral-700">
              From
            </label>
            <input
              id={fromId}
              type="date"
              value={from}
              onChange={(event) => changeFilter(() => setFrom(event.target.value))}
              className="h-10 rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 transition-colors hover:border-neutral-400"
            />
          </div>

          <div>
            <label htmlFor={toId} className="mb-1.5 block text-xs font-semibold text-neutral-700">
              To
            </label>
            <input
              id={toId}
              type="date"
              value={to}
              onChange={(event) => changeFilter(() => setTo(event.target.value))}
              className="h-10 rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 transition-colors hover:border-neutral-400"
            />
          </div>

          {filtersActive && (
            <button
              type="button"
              onClick={() =>
                changeFilter(() => {
                  setActionType('');
                  setFrom('');
                  setTo('');
                })
              }
              className={buttonClass('secondary')}
            >
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {exportError != null && (
        <div className="mb-5">
          <ErrorState
            error={exportError}
            title={
              isApiError(exportError) && exportError.isForbidden
                ? 'You do not have access to export the audit log'
                : 'The export could not be produced'
            }
          />
        </div>
      )}

      <AuditBody
        query={query}
        filtersActive={filtersActive}
        onNext={(next) => setCursor(next)}
        canGoBack={cursor !== undefined}
        onReset={() => setCursor(undefined)}
      />
    </div>
  );
}

function AuditBody({
  query,
  filtersActive,
  onNext,
  canGoBack,
  onReset,
}: {
  query: ReturnType<typeof useAuditLog>;
  filtersActive: boolean;
  onNext: (cursor: string) => void;
  canGoBack: boolean;
  onReset: () => void;
}) {
  if (query.isPending) {
    return (
      <LoadingState label="Loading the audit log…">
        <SkeletonTable rows={8} columns={4} />
      </LoadingState>
    );
  }

  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const report = query.data;
  if (!report) return null;

  if (report.data.length === 0) {
    return (
      <EmptyState
        variant={filtersActive ? 'filtered' : 'empty'}
        title={filtersActive ? 'No entries match these filters' : 'No audit entries yet'}
        description={
          filtersActive
            ? 'No recorded action in your company matches the action or dates you selected.'
            : 'Actions are recorded here as they happen.'
        }
      />
    );
  }

  return (
    <>
      <Card className="overflow-hidden" as="div">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Recorded actions, newest first</caption>
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left">
                <Th>When</Th>
                <Th>Actor</Th>
                <Th>Action</Th>
                <Th>Resource</Th>
              </tr>
            </thead>
            <tbody>
              {report.data.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <nav
        aria-label="Pagination"
        className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm text-neutral-500"
      >
        <span>
          Showing {report.data.length} of {report.totalCount}{' '}
          {report.totalCount === 1 ? 'entry' : 'entries'}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReset}
            disabled={!canGoBack}
            aria-disabled={!canGoBack}
            className={buttonClass('secondary')}
          >
            First page
          </button>
          <button
            type="button"
            onClick={() => report.nextCursor && onNext(report.nextCursor)}
            disabled={!report.nextCursor}
            aria-disabled={!report.nextCursor}
            className={buttonClass('secondary')}
          >
            Next
          </button>
        </div>
      </nav>
    </>
  );
}

function Row({ row }: { row: AuditRow }) {
  /*
   * An AI-influenced decision is called out (FR8.3 names them specifically).
   * Tone is `info`, not a warning: a scoring event is a normal record, and
   * §8.2 reserves warning for something that needs attention.
   */
  const aiInfluenced = row.action.startsWith('score.');

  return (
    <tr className="border-b border-neutral-200 transition-colors last:border-0 hover:bg-neutral-50">
      <td className="whitespace-nowrap px-4 py-3 text-neutral-700">
        {formatDateTime(row.createdAt)}
      </td>
      <td className="px-4 py-3 text-neutral-900">
        {/* A null actor is a real state: a public application submission has no
            signed-in user, and the filter records it as such rather than
            attributing it to somebody. */}
        {row.actorEmail ?? <span className="text-neutral-400">System / public</span>}
      </td>
      <td className="px-4 py-3">
        <span className="inline-flex items-center gap-2">
          <span className="text-neutral-900">{formatAction(row.action)}</span>
          {aiInfluenced && <Badge tone="info">AI-influenced</Badge>}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="text-neutral-700">{row.resourceType}</span>
        <span className="ml-2 font-mono text-xs text-neutral-400">
          {row.resourceId.slice(0, 8)}…
        </span>
      </td>
    </tr>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-neutral-500"
    >
      {children}
    </th>
  );
}
