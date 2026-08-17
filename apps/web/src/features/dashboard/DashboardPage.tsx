import { Link } from 'react-router-dom';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, Skeleton, SkeletonTable } from '../../components/Skeleton';
import { FunnelBars } from '../analytics/FunnelBars';
import { AiScoringBadge, JobStatusBadge } from '../jobs/JobStatusBadge';
import type { JobResponse } from '../jobs/useJobs';
import { useDashboard } from './useDashboard';

/**
 * RC-01 — the recruiter dashboard (Table 5.1; §8.1, §9.1.2).
 *
 * A CROSS-REQUISITION OVERVIEW, assembled from `GET /v1/jobs` and
 * `GET /v1/analytics/funnel`. Every number on this page is one the API stated;
 * nothing is derived beyond counting rows by status.
 *
 * The funnel snapshot reuses RC-12's `FunnelBars` rather than drawing a second
 * chart, so the two screens cannot disagree about what the pipeline looks like.
 */
export function DashboardPage() {
  const dashboard = useDashboard();

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-neutral-500">RC-01</p>
          <h1 className="text-2xl font-semibold text-neutral-900">Dashboard</h1>
          <p className="mt-1 text-sm text-neutral-700">
            Your requisitions and how candidates are moving through them.
          </p>
        </div>
        {/* Table 5.1's primary actions are "Open job" and "Create job". */}
        <Link
          to="/jobs/new"
          className="inline-flex h-10 items-center rounded-md bg-primary-700 px-4 text-sm font-semibold text-neutral-0 hover:bg-primary-600"
        >
          Create job
        </Link>
      </header>

      {dashboard.isPending ? (
        <LoadingState label="Loading your dashboard…">
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Skeleton className="h-[92px]" />
              <Skeleton className="h-[92px]" />
              <Skeleton className="h-[92px]" />
            </div>
            <Skeleton className="h-[240px]" />
            <SkeletonTable rows={3} columns={4} />
          </div>
        </LoadingState>
      ) : dashboard.isError ? (
        <ErrorState error={dashboard.error} onRetry={dashboard.refetch} />
      ) : dashboard.all.length === 0 ? (
        // Table 5.1's "empty (no jobs)". One CTA, because creating a job is the
        // only thing a recruiter with none can usefully do.
        <EmptyState
          title="No jobs yet"
          description="Create your first requisition and this dashboard will show how candidates move through it."
          action={
            <Link
              to="/jobs/new"
              className="inline-flex h-10 items-center rounded-md bg-primary-700 px-4 text-sm font-semibold text-neutral-0 hover:bg-primary-600"
            >
              Create job
            </Link>
          }
        />
      ) : (
        <div className="space-y-4">
          <StatTiles dashboard={dashboard} />
          <FunnelSnapshot dashboard={dashboard} />
          <ActiveJobsTable jobs={dashboard.all} hasMore={dashboard.hasMore} />
        </div>
      )}
    </div>
  );
}

function StatTiles({ dashboard }: { dashboard: ReturnType<typeof useDashboard> }) {
  const total = dashboard.funnel.data?.totalApplications ?? 0;
  const hired = dashboard.funnel.data?.timeToHire?.hiredCount ?? 0;

  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label="Open requisitions"
        value={String(dashboard.published.length)}
        hint={
          dashboard.drafts.length > 0 || dashboard.closed.length > 0
            ? `${dashboard.drafts.length} draft, ${dashboard.closed.length} closed`
            : undefined
        }
      />
      <Tile label="Applications" value={String(total)} />
      <Tile label="Hired" value={String(hired)} />

      {/*
        Stated as unavailable rather than shown as zero — see `useDashboard`.
        A "0" here would read as "nothing needs review", which is a claim the
        API has not made.
      */}
      <div className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
        <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Awaiting review
        </dt>
        <dd className="mt-1 text-2xl font-semibold text-neutral-300">—</dd>
        <p className="mt-0.5 text-xs text-neutral-500">
          No cross-job count exists yet; parsing runs from Phase 3.
        </p>
      </div>
    </dl>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
      <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold text-neutral-900">{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}

/** The funnel snapshot, tenant-wide, linking through to RC-12 for the detail. */
function FunnelSnapshot({ dashboard }: { dashboard: ReturnType<typeof useDashboard> }) {
  const report = dashboard.funnel.data;
  if (!report) return null;

  if (report.totalApplications === 0) {
    return (
      <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
        <h2 className="text-base font-semibold text-neutral-900">Funnel</h2>
        <p className="mt-2 text-sm text-neutral-700">
          No applications yet, so there is nothing to chart. Share a published job&rsquo;s link to
          start receiving candidates.
        </p>
      </section>
    );
  }

  return (
    <div>
      <FunnelBars stages={report.stages} totalApplications={report.totalApplications} />
      <p className="mt-2 text-sm">
        <Link to="/analytics" className="text-primary-700 hover:underline">
          Open full analytics
        </Link>
      </p>
    </div>
  );
}

function ActiveJobsTable({ jobs, hasMore }: { jobs: JobResponse[]; hasMore: boolean }) {
  return (
    <section className="rounded-md border border-neutral-300 bg-neutral-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-300 p-4">
        <h2 className="text-base font-semibold text-neutral-900">Jobs</h2>
        <Link to="/jobs" className="text-sm text-primary-700 hover:underline">
          View all jobs
        </Link>
      </div>

      <ul className="divide-y divide-neutral-300">
        {jobs.map((job) => (
          <li key={job.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              {/* Table 5.1's "Open job" action. */}
              <Link
                to={`/jobs/${job.id}`}
                className="rounded-sm text-sm font-semibold text-primary-700 hover:underline"
              >
                {job.title}
              </Link>
              <p className="mt-0.5 text-xs text-neutral-700">
                {[job.department, job.location].filter(Boolean).join(' · ') ||
                  'No details recorded'}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <JobStatusBadge status={job.status} />
              <AiScoringBadge enabled={job.aiScoringEnabled} />
            </div>
          </li>
        ))}
      </ul>

      {hasMore && (
        // The counts above describe the loaded page; a cursor API reports no
        // total, so saying so beats implying these are all the jobs there are.
        <p className="border-t border-neutral-300 px-4 py-3 text-xs text-neutral-500">
          More jobs exist beyond this page — the counts above cover the ones shown here.
        </p>
      )}
    </section>
  );
}
