import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, PageHeader, buttonClass } from '../../components/ui';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, SkeletonText } from '../../components/Skeleton';
import { formatRequestedAt, useReviews, type ReviewItem, type ReviewStatus } from './useReviews';

/**
 * HM-01 — everything waiting on this reviewer.
 *
 * THE HIRING MANAGER'S LANDING PAGE. A recruiter opens a dashboard of pipeline
 * health; a reviewer opens a list of people to assess. §24.2 keeps that persona
 * on assessment rather than record-keeping, so this screen answers one question
 * — who is waiting for my scorecard — and links straight into the candidate.
 *
 * NO CROSS-JOB AGGREGATES, NO FUNNEL, NO COUNTS BEYOND THIS LIST. Those come
 * from `GET /v1/analytics/funnel`, which is Recruiter and Admin only; showing
 * them here would mean either a 403 or an invented number.
 */
export function MyReviewsPage() {
  const [status, setStatus] = useState<ReviewStatus | 'all'>('pending');
  const query = useReviews(status === 'all' ? undefined : status);

  return (
    <div>
      <PageHeader
        code="HM-01"
        title="My reviews"
        description="Candidates on the jobs you are assigned to."
      />

      <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Filter reviews">
        {(['pending', 'completed', 'all'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatus(value)}
            aria-pressed={status === value}
            className={buttonClass(status === value ? 'primary' : 'secondary', 'sm')}
          >
            {value === 'all' ? 'All' : value === 'pending' ? 'Awaiting my scorecard' : 'Completed'}
          </button>
        ))}
      </div>

      {query.isPending && (
        <LoadingState label="Loading your reviews…">
          <Card>
            <div className="p-5">
              <SkeletonText lines={4} />
            </div>
          </Card>
        </LoadingState>
      )}

      {query.isError && (
        <ErrorState
          error={query.error}
          title="Your reviews could not be loaded"
          onRetry={() => void query.refetch()}
        />
      )}

      {query.data && query.data.data.length === 0 && (
        /*
         * Gap 1 — "an empty queue is not an error". The wording changes with the
         * filter so a reviewer who has finished everything is congratulated
         * rather than told they have no assignments.
         */
        <EmptyState
          title={
            status === 'completed'
              ? 'You have not completed any reviews yet'
              : status === 'pending'
                ? 'Nothing is waiting for you'
                : 'You have no reviews'
          }
          description={
            status === 'pending'
              ? 'When a recruiter assigns you to a job, its candidates appear here.'
              : 'Reviews appear here once you are assigned to a job.'
          }
        />
      )}

      {query.data && query.data.data.length > 0 && (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {query.data.data.map((review) => (
              <ReviewRow key={review.applicationId} review={review} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ReviewRow({ review }: { review: ReviewItem }) {
  /*
   * Deep-links into the candidate under its job, so the breadcrumb resolves and
   * `JobAssignmentGuard` sees the job id it scopes on. A bare application route
   * would have neither.
   */
  const to = `/jobs/${review.jobId}/candidates/${review.applicationId}`;

  return (
    <li>
      <Link
        to={to}
        className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-neutral-50"
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neutral-900">{review.candidateName}</p>
          <p className="mt-0.5 truncate text-sm text-neutral-500">{review.jobTitle}</p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs text-neutral-500">
            Applied {formatRequestedAt(review.requestedAt)}
          </span>
          {/*
            The flag is per-reviewer: it says whether YOU have submitted, not
            whether the panel has. Wording it as "your scorecard" keeps that
            from being read as the team's state.
          */}
          {review.scorecardSubmitted ? (
            <Badge tone="success">Your scorecard is in</Badge>
          ) : (
            <Badge tone="warning">Awaiting your scorecard</Badge>
          )}
        </div>
      </Link>
    </li>
  );
}
