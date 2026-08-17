import { ErrorState } from '../../components/ErrorState';
import { SkeletonText } from '../../components/Skeleton';
import { formatRole, type ScorecardResponse } from './useApplication';
import { ScorecardForm } from './ScorecardForm';
import { MAX_RATING } from './useScorecardMutation';

/**
 * The scorecards panel on RC-06 (§7.3 right column; FR5.3, RC-13).
 *
 * READS THE TEAM'S FEEDBACK AND COLLECTS THE CALLER'S. The composer lives here
 * rather than on its own screen for the same reason the comment thread does:
 * `POST /v1/applications/:id/scorecards` admits Recruiter as well as Hiring
 * Manager, and a rating is only meaningful beside the ones already submitted.
 */
export function ScorecardList({
  applicationId,
  query,
}: {
  applicationId: string | undefined;
  query: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    data: ScorecardResponse[] | undefined;
    refetch: () => void;
  };
}) {
  return (
    <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
      <h2 className="text-base font-semibold text-neutral-900">Scorecards</h2>

      {query.isPending && (
        <div className="mt-3" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading scorecards…</span>
          <SkeletonText lines={2} />
        </div>
      )}

      {query.isError && (
        <div className="mt-3">
          <ErrorState
            error={query.error}
            title="Scorecards could not be loaded"
            onRetry={() => query.refetch()}
          />
        </div>
      )}

      {!query.isPending && !query.isError && (query.data?.length ?? 0) === 0 && (
        // Not an EmptyState card: this is one panel among three, and a full
        // empty-state block would outweigh the section it sits in.
        <p className="mt-2 text-sm text-neutral-500">
          No scorecards submitted yet. Interviewers add these after meeting the candidate.
        </p>
      )}

      {query.data && query.data.length > 0 && (
        <ul className="mt-3 space-y-3">
          {query.data.map((scorecard) => (
            <li
              key={scorecard.id}
              className="border-t border-neutral-300 pt-3 first:border-0 first:pt-0"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-neutral-900">
                  {/*
                    Numeric as well as visual — §10.3 forbids a rating that is
                    conveyed by shape alone, and "4 of 5" survives a screen
                    reader where five glyphs do not.
                  */}
                  {scorecard.rating} of {MAX_RATING}
                </p>
                <p className="text-xs text-neutral-500">{formatDate(scorecard.submittedAt)}</p>
              </div>
              <p className="mt-0.5 text-xs text-neutral-500">
                {scorecard.author.email} · {formatRole(scorecard.author.role)}
              </p>
              {/* `feedback` is nullable — a rating alone is a valid scorecard. */}
              {scorecard.feedback && (
                <p className="mt-2 max-w-[70ch] whitespace-pre-line text-sm text-neutral-700">
                  {scorecard.feedback}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {/*
        RC-13. Rendered even while the list is loading or failed: the caller's
        ability to record their own assessment does not depend on being able to
        read everyone else's.
      */}
      <ScorecardForm applicationId={applicationId} />
    </section>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
