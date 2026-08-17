import { Link, useParams } from 'react-router-dom';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, SkeletonTable } from '../../components/Skeleton';
import { JobHeader } from '../jobs/JobHeader';
import { useJob } from '../jobs/useJobs';
import {
  formatStage,
  useJobCandidates,
  type JobCandidateResponse,
  type WireScore,
} from './useJobCandidates';

/**
 * RC-05 — the candidate list for one job (Table 5.1, §7.2;
 * `GET /v1/jobs/:id/candidates`).
 *
 * TWO THINGS THE SPEC ASKS FOR THAT THE API CANNOT SERVE, both left out
 * rather than faked:
 *
 *   Filters (search, stage, score range, flagged) — `ListJobCandidatesQueryDto`
 *   accepts only `cursor` and `limit`, and the global ValidationPipe runs with
 *   `forbidNonWhitelisted`, so an invented parameter is a 400. The DTO records
 *   that no document ever specified their names.
 *
 *   A total count ("Candidates (147)") — cursor pagination never counts the
 *   full set, and no endpoint returns one. The header reports how many rows
 *   have been LOADED, which is a different and true statement.
 *
 * Bulk select (RC-10), weight adjustment (RC-08) and score override (RC-07)
 * are separate screens and out of scope.
 */
export function CandidateListPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const jobQuery = useJob(jobId);
  const candidates = useJobCandidates(jobId);

  /*
   * FR4.5 keys off the JOB's flag, not off the rows. A list that happened to
   * contain no scores would look identical, but the reason differs and so does
   * the message a recruiter needs — "switched off for this job" versus "the
   * scorer did not answer".
   */
  const aiDisabled = jobQuery.data ? !jobQuery.data.aiScoringEnabled : false;
  const rows = candidates.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <div>
      <JobHeader job={jobQuery.data} loading={jobQuery.isPending} activeTab="candidates" />

      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold text-neutral-900">
          Candidates
          {rows.length > 0 && (
            // "Loaded", never a total — see the file header.
            <span className="ml-2 text-sm font-normal text-neutral-500">
              {rows.length} loaded
              {candidates.hasNextPage ? '+' : ''}
            </span>
          )}
        </h2>
        <p className="font-mono text-xs text-neutral-500">RC-05</p>
      </div>

      {/*
        §7.2's AI-disabled variant, worded as the document words it. info/700
        is §8.2's designated colour for an AI-disabled notice — deliberately
        not a warning: nothing is wrong, the feature is off.
      */}
      {aiDisabled && (
        <p className="mb-4 rounded-sm border border-info-700 bg-neutral-0 px-3 py-2 text-sm text-info-700">
          AI scoring is disabled for this job by your administrator. Candidates are listed newest
          first, with no score.
        </p>
      )}

      <CandidateListBody query={candidates} rows={rows} jobId={jobId} showScore={!aiDisabled} />
    </div>
  );
}

function CandidateListBody({
  query,
  rows,
  jobId,
  showScore,
}: {
  query: ReturnType<typeof useJobCandidates>;
  rows: JobCandidateResponse[];
  jobId: string | undefined;
  showScore: boolean;
}) {
  if (query.isPending) {
    // §7.2 draws eight skeleton rows while the table loads.
    return (
      <LoadingState label="Loading candidates…">
        <SkeletonTable rows={8} columns={3} />
      </LoadingState>
    );
  }

  if (query.isError) {
    // §7.2: "inline retry panel replacing the table body".
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  if (rows.length === 0) {
    // §7.2's empty copy, verbatim.
    return (
      <EmptyState
        title="No applications yet"
        description="Share the job link to start receiving candidates."
      />
    );
  }

  return (
    <>
      <div
        aria-busy={query.isFetchingNextPage}
        className={query.isFetchingNextPage ? 'opacity-60' : undefined}
      >
        <ul className="divide-y divide-neutral-300 overflow-hidden rounded-md border border-neutral-300 bg-neutral-0">
          {rows.map((row) => (
            <li key={row.applicationId}>
              <CandidateRow row={row} jobId={jobId} showScore={showScore} />
            </li>
          ))}
        </ul>
      </div>

      {/* §7.2 — "Load more", not numbered pages. */}
      {query.hasNextPage && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            aria-disabled={query.isFetchingNextPage}
            className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 disabled:opacity-40"
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}

function CandidateRow({
  row,
  jobId,
  showScore,
}: {
  row: JobCandidateResponse;
  jobId: string | undefined;
  showScore: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 hover:bg-neutral-100">
      <div className="min-w-0">
        <Link
          to={`/jobs/${jobId ?? ''}/candidates/${row.applicationId}`}
          className="rounded-sm text-base font-semibold text-primary-700 hover:underline"
        >
          {row.candidate.fullName}
        </Link>
        <p className="mt-0.5 text-sm text-neutral-700">{row.candidate.email}</p>
        <p className="mt-1 text-xs text-neutral-500">Applied {formatDate(row.appliedAt)}</p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {/*
          The score column exists ONLY when the job is scored. §7.2 requires it
          removed entirely rather than greyed, so an unscored list cannot read
          as a scored list whose values failed to load.
        */}
        {showScore && <ScoreCell score={row.score} />}
        <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs font-semibold text-neutral-700">
          {formatStage(row.currentStage)}
        </span>
      </div>
    </div>
  );
}

/**
 * Score plus its rationale — one unit, never separable (BR-02, NFR7).
 *
 * Reached only when the job has scoring enabled. `score` can still be null in
 * that case, which is the SY-02 "AI-unavailable" reading rather than FR4.5's:
 * the job expects a score and none came back, so the row says so instead of
 * showing a blank where a number belongs.
 */
function ScoreCell({ score }: { score: WireScore | null }) {
  if (!score) {
    return <span className="text-sm text-neutral-500">No score available</span>;
  }

  return (
    <div className="text-right">
      {/*
        §8.2's semantic rule: magnitude uses the neutral/primary ramp and never
        success/danger, because red on a low score would read as a rejection
        recommendation the system is forbidden to make (BR-01).
      */}
      <p className="font-mono text-sm font-semibold text-neutral-900">
        {score.composite.toFixed(2)}
      </p>
      <p className="max-w-xs text-xs text-neutral-700">{score.rationale.summary}</p>
      {score.overridden && (
        <span className="mt-1 inline-flex rounded-sm border border-warning-700 px-2 py-0.5 text-xs font-semibold text-warning-700">
          Overridden
        </span>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
