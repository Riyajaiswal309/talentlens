import { Link } from 'react-router-dom';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, Skeleton, SkeletonTable } from '../../components/Skeleton';
import {
  ArrowRightIcon,
  BriefcaseIcon,
  CheckIcon,
  InboxIcon,
  UsersIcon,
} from '../../components/icons';
import { ButtonLink, Card, CardHeader, PageHeader, StatCard } from '../../components/ui';
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
 *
 * NO "UPCOMING INTERVIEWS" PANEL. Interviews are readable only per application
 * (`GET /v1/applications/:id/interviews`); there is no recruiter-wide or
 * date-ranged interview endpoint, so such a panel could only be filled by
 * fanning out a request per application or by inventing rows. Neither is
 * acceptable, so the panel is absent and the reason is recorded here.
 */
export function DashboardPage() {
  const dashboard = useDashboard();

  return (
    <div>
      <PageHeader
        code="RC-01"
        title="Dashboard"
        description="Your requisitions and how candidates are moving through them."
        actions={<ButtonLink to="/jobs/new">Create job</ButtonLink>}
      />

      {dashboard.isPending ? (
        <LoadingState label="Loading your dashboard…">
          <div className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <Skeleton className="h-[120px] rounded-lg" />
              <Skeleton className="h-[120px] rounded-lg" />
              <Skeleton className="h-[120px] rounded-lg" />
              <Skeleton className="h-[120px] rounded-lg" />
            </div>
            <Skeleton className="h-[280px] rounded-lg" />
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
          action={<ButtonLink to="/jobs/new">Create job</ButtonLink>}
        />
      ) : (
        <div className="space-y-5">
          <StatTiles dashboard={dashboard} />
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <FunnelSnapshot dashboard={dashboard} />
            </div>
            <PipelineBreakdown dashboard={dashboard} />
          </div>
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
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Open requisitions"
        value={String(dashboard.published.length)}
        icon={<BriefcaseIcon />}
        hint={
          dashboard.drafts.length > 0 || dashboard.closed.length > 0
            ? `${dashboard.drafts.length} draft, ${dashboard.closed.length} closed`
            : undefined
        }
      />
      <StatCard label="Applications" value={String(total)} icon={<UsersIcon />} />
      <StatCard label="Hired" value={String(hired)} icon={<CheckIcon />} />

      {/*
        Stated as unavailable rather than shown as zero — see `useDashboard`.
        A "0" here would read as "nothing needs review", which is a claim the
        API has not made.
      */}
      <StatCard
        label="Awaiting review"
        value="—"
        muted
        icon={<InboxIcon />}
        hint="No cross-job count exists yet; parsing runs from Phase 3."
      />
    </div>
  );
}

/** The funnel snapshot, tenant-wide, linking through to RC-12 for the detail. */
function FunnelSnapshot({ dashboard }: { dashboard: ReturnType<typeof useDashboard> }) {
  const report = dashboard.funnel.data;
  if (!report) return null;

  if (report.totalApplications === 0) {
    return (
      <Card className="h-full p-5">
        <h2 className="text-base font-semibold text-neutral-900">Funnel</h2>
        <p className="mt-2 text-sm text-neutral-500">
          No applications yet, so there is nothing to chart. Share a published job&rsquo;s link to
          start receiving candidates.
        </p>
      </Card>
    );
  }

  return (
    <Card className="h-full">
      <CardHeader
        title="Hiring funnel"
        description={`Across ${report.totalApplications} application${
          report.totalApplications === 1 ? '' : 's'
        }`}
        action={
          <Link
            to="/analytics"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-700 hover:underline"
          >
            Full analytics
            <ArrowRightIcon />
          </Link>
        }
      />
      <div className="p-5">
        <FunnelBars stages={report.stages} totalApplications={report.totalApplications} />
      </div>
    </Card>
  );
}

/**
 * Where candidates are sitting right now.
 *
 * `currentlyHere` is the API's own per-stage occupancy — the same field RC-09's
 * board columns are counted from, so the two cannot disagree.
 */
function PipelineBreakdown({ dashboard }: { dashboard: ReturnType<typeof useDashboard> }) {
  const report = dashboard.funnel.data;
  if (!report || report.totalApplications === 0) return null;

  const peak = Math.max(...report.stages.map((stage) => stage.currentlyHere), 1);

  return (
    <Card className="h-full">
      <CardHeader title="Pipeline now" description="Candidates currently in each stage" />
      <ul className="divide-y divide-neutral-200">
        {report.stages.map((stage) => (
          <li key={stage.name} className="flex items-center gap-3 px-5 py-3">
            <span className="w-24 shrink-0 truncate text-sm text-neutral-700">{stage.name}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-100">
              {/*
                §8.2 — magnitude uses the neutral/primary ramp, never
                success/danger: a red bar on a low stage would read as a
                recommendation the system is forbidden to make (BR-01).
              */}
              <span
                className="block h-full rounded-full bg-primary-500 transition-[width] duration-300"
                style={{ width: `${(stage.currentlyHere / peak) * 100}%` }}
              />
            </span>
            <span className="w-8 shrink-0 text-right font-mono text-sm font-semibold tabular-nums text-neutral-900">
              {stage.currentlyHere}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ActiveJobsTable({ jobs, hasMore }: { jobs: JobResponse[]; hasMore: boolean }) {
  return (
    <Card>
      <CardHeader
        title="Jobs"
        description="Requisitions in your company"
        action={
          <Link
            to="/jobs"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-700 hover:underline"
          >
            View all jobs
            <ArrowRightIcon />
          </Link>
        }
      />

      <ul className="divide-y divide-neutral-200">
        {jobs.map((job) => (
          <li
            key={job.id}
            className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-neutral-50"
          >
            <div className="min-w-0">
              {/* Table 5.1's "Open job" action. */}
              <Link
                to={`/jobs/${job.id}`}
                className="rounded-sm text-sm font-semibold text-neutral-900 hover:text-primary-700"
              >
                {job.title}
              </Link>
              <p className="mt-0.5 text-xs text-neutral-500">
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
        <p className="border-t border-neutral-200 px-5 py-3 text-xs text-neutral-500">
          More jobs exist beyond this page — the counts above cover the ones shown here.
        </p>
      )}
    </Card>
  );
}
