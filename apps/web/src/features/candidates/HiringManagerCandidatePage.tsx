import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Avatar, Badge, Card, CardHeader, Notice } from '../../components/ui';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, Skeleton, SkeletonText } from '../../components/Skeleton';
import { useBreadcrumbLabel } from '../../layouts/Breadcrumbs';
import { useJob } from '../jobs/useJobs';
import { CommentThread } from './CommentThread';
import { ScorecardList } from './ScorecardList';
import { TagPanel } from './TagPanel';
import { InterviewPanel } from './InterviewPanel';
import { useComments, useScorecards, useApplicationInterviews } from './useApplication';
import { formatStage, useJobCandidates, type JobCandidateResponse } from './useJobCandidates';
import { ScorePanel } from './ScorePanel';

/**
 * HM-03 — the reviewer's view of one candidate.
 *
 * A SEPARATE PAGE FROM `CandidateDetailPage`, and not by preference. That page
 * is built on `GET /v1/applications/:id`, which **excludes HIRING_MANAGER** by
 * Handoff row 13 — the same decision that made `…/scorecards` its own endpoint
 * (amendment B1). Pointing a Hiring Manager at it would produce a 403, so this
 * screen is assembled from the endpoints their role actually holds:
 *
 *   identity, stage, AI score + rationale  ← GET /v1/jobs/:id/candidates
 *   scorecards, comments, tags, interviews ← the four sibling routes
 *
 * WHAT IS ABSENT IS STATED, NOT FAKED. The resume and parsed profile live only
 * inside the excluded route, so this page says so plainly rather than showing
 * an empty panel that implies the candidate attached nothing. Source of hire,
 * stage history and parser internals are absent for the same reason and are
 * not mentioned at all — §24.2 scopes this persona to assessment, so their
 * absence is correct rather than a limitation worth apologising for.
 *
 * NOTHING HERE IS A SECURITY BOUNDARY. Every endpoint re-checks the role, and
 * `JobAssignmentGuard` refuses an unassigned job with a 404 regardless of what
 * this component renders.
 */
export function HiringManagerCandidatePage() {
  const { jobId, applicationId } = useParams<{ jobId: string; applicationId: string }>();

  const job = useJob(jobId);
  const candidates = useJobCandidates(jobId);
  const scorecards = useScorecards(applicationId);
  const comments = useComments(applicationId);
  const interviews = useApplicationInterviews(applicationId);

  /*
   * The candidate is found in the job's list rather than fetched alone: there
   * is no single-application read this role may call. The list is already
   * cached from the candidates screen in the normal flow, so arriving from
   * "My reviews" is the only case that pays for the request.
   *
   * PAGES ARE WALKED, NOT JUST THE FIRST. `useJobCandidates` is an infinite
   * query with a 20-row page, so a candidate deep-linked from the review queue
   * on a busy job is very often not in page one. Stopping at the first page
   * would have shown "not on this job" for a candidate who plainly is.
   */
  const rows: JobCandidateResponse[] = candidates.data?.pages.flatMap((page) => page.data) ?? [];
  const application = rows.find((row) => row.applicationId === applicationId);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = candidates;
  useEffect(() => {
    if (!application && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [application, hasNextPage, isFetchingNextPage, fetchNextPage]);

  useBreadcrumbLabel(jobId, job.data?.title);
  useBreadcrumbLabel(applicationId, application?.candidate.fullName);

  if (candidates.isPending) {
    return (
      <LoadingState label="Loading candidate…">
        <div className="space-y-4">
          <Skeleton className="h-[28px] w-64" />
          <SkeletonText lines={4} />
        </div>
      </LoadingState>
    );
  }

  if (candidates.isError) {
    // A job the reviewer is not assigned to is a 404 here, exactly as it is on
    // every other job-scoped route.
    return (
      <ErrorState error={candidates.error} onRetry={() => void candidates.refetch()} as="h1" />
    );
  }

  if (!application && (hasNextPage || isFetchingNextPage)) {
    return (
      <LoadingState label="Loading candidate…">
        <div className="space-y-4">
          <Skeleton className="h-[28px] w-64" />
          <SkeletonText lines={4} />
        </div>
      </LoadingState>
    );
  }

  if (!application) {
    return (
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">Candidate not found</h1>
        <div className="mt-6">
          <EmptyState
            title="This candidate is not on this job"
            description="They may have been withdrawn, or the link may point at another job. Open the job to see who is currently in review."
            action={
              jobId ? (
                <Link
                  to={`/jobs/${jobId}/candidates`}
                  className="text-sm font-medium text-primary-700 hover:underline"
                >
                  Back to candidates
                </Link>
              ) : undefined
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <header className="mb-6">
        <p className="font-mono text-2xs uppercase tracking-widest text-neutral-400">HM-03</p>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <Avatar name={application.candidate.fullName} size="lg" />
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold text-neutral-900">
                {application.candidate.fullName}
              </h1>
              <p className="mt-1 text-sm text-neutral-500">{application.candidate.email}</p>
              {job.data && (
                <p className="mt-1.5 text-sm text-neutral-500">
                  Reviewing for{' '}
                  <Link
                    to={`/jobs/${job.data.id}/candidates`}
                    className="font-medium text-primary-700 hover:underline"
                  >
                    {job.data.title}
                  </Link>
                </p>
              )}
            </div>
          </div>

          {/*
            Stage is SHOWN but not editable — `PATCH …/stage` is Recruiter and
            Admin only. A reviewer needs to know where the candidate is; moving
            them is pipeline mechanics, which §24.2 keeps away from this role.
          */}
          <Badge tone="primary">{formatStage(application.currentStage)}</Badge>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/*
            The SAME panel the recruiter sees, minus the override control.
            FR4.3's `PATCH …/score` is Recruiter and Admin only, and `readOnly`
            is what keeps a button off this page that would 403 — the score and
            its rationale are identical for both roles.
          */}
          <ScorePanel
            score={application.score}
            aiScoringEnabled={job.data?.aiScoringEnabled}
            jobLoading={job.isPending}
            applicationId={applicationId}
            readOnly
          />
          <ResumeUnavailableNotice />
          <CommentThread applicationId={applicationId} query={comments} />
        </div>

        <div className="space-y-5">
          <TagPanel applicationId={applicationId} />
          <ScorecardList applicationId={applicationId} query={scorecards} />
          {/* D26 — a Hiring Manager reads interviews but does not create one. */}
          <InterviewPanel query={interviews} readOnly />
        </div>
      </div>
    </div>
  );
}

/**
 * Says why the resume is not here.
 *
 * AN EXPLICIT ABSENCE, NOT AN EMPTY PANEL. The resume and parsed profile are
 * served only by `GET /v1/applications/:id`, which this role may not call. A
 * blank section would read as "this candidate uploaded nothing", which is a
 * different and false claim.
 */
function ResumeUnavailableNotice() {
  return (
    <Card>
      <CardHeader title="Resume" />
      <div className="p-5">
        <Notice tone="info" title="Not available to your role">
          <p>
            The resume and the details extracted from it are part of the recruiter’s record and are
            not served to hiring managers. Your assessment here is based on the match score and its
            rationale, and on the panel’s scorecards and comments.
          </p>
          <p className="mt-1">Ask the recruiter on this job if you need the resume itself.</p>
        </Notice>
      </div>
    </Card>
  );
}
