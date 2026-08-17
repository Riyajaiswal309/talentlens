import { NavLink } from 'react-router-dom';
import { useBreadcrumbLabel } from '../../layouts/Breadcrumbs';
import { Skeleton } from '../../components/Skeleton';
import { AiScoringBadge, JobStatusBadge } from './JobStatusBadge';
import type { JobResponse } from './useJobs';

/**
 * The RC-04 header and tab bar, shared by the job's own screens.
 *
 * Table 5.1 makes RC-04 a hub with a tab bar, and RC-05 sits inside it — so
 * the header travels with both rather than being redrawn per page.
 *
 * IT ALSO OWNS THE BREADCRUMB LABEL. The layout builds the trail from the URL,
 * which carries an id; only a component holding the fetched job knows the
 * title. Registering it here is what turns `Jobs › 00000000` into
 * `Jobs › Senior Backend Engineer` (§4.1).
 */
/** The tabs that lead somewhere. `Settings` is still unbuilt. */
export type JobTab = 'overview' | 'candidates' | 'pipeline' | 'weights';

export function JobHeader({
  job,
  loading,
  activeTab,
}: {
  job: JobResponse | undefined;
  loading: boolean;
  activeTab: JobTab;
}) {
  useBreadcrumbLabel(job?.id, job?.title);

  if (loading || !job) {
    return (
      <header className="mb-6">
        <Skeleton className="h-[14px] w-16" />
        <Skeleton className="mt-2 h-[28px] w-72" />
        <Skeleton className="mt-3 h-[14px] w-96" />
      </header>
    );
  }

  const closed = job.status === 'CLOSED';

  return (
    <header className="mb-6">
      <p className="font-mono text-xs text-neutral-500">RC-04</p>
      <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold text-neutral-900">{job.title}</h1>
        <div className="flex gap-2">
          <JobStatusBadge status={job.status} />
          <AiScoringBadge enabled={job.aiScoringEnabled} />
        </div>
      </div>

      <p className="mt-1 text-sm text-neutral-700">
        {[job.department, job.location, job.employmentType, job.experienceLevel]
          .filter(Boolean)
          .join(' · ') || 'No further details recorded'}
      </p>

      {/*
        Table 5.1's "closed-job read-only state". The screens that would edit
        this job (RC-03) are not built, so there is nothing to disable — the
        banner states the condition rather than pretending to enforce it.
      */}
      {closed && (
        <p className="mt-3 rounded-sm border border-neutral-300 bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
          This job is closed. It is shown read-only.
        </p>
      )}

      <JobTabs jobId={job.id} activeTab={activeTab} />
    </header>
  );
}

/**
 * Overview / Candidates / Pipeline / Settings (Table 5.1).
 *
 * Settings is the only one still unbuilt — it carries the read-only AI-scoring
 * status (BR-04) and nothing else is specified for it — so it stays a disabled
 * span rather than a link to a route that does not exist.
 */
function JobTabs({ jobId, activeTab }: { jobId: string; activeTab: JobTab }) {
  const base = 'border-b-2 px-1 pb-2 text-sm font-semibold';

  return (
    <nav aria-label="Job sections" className="mt-5 border-b border-neutral-300">
      <ul className="flex gap-6">
        <li>
          <NavLink
            to={`/jobs/${jobId}`}
            end
            aria-current={activeTab === 'overview' ? 'page' : undefined}
            className={`${base} ${
              activeTab === 'overview'
                ? 'border-primary-700 text-primary-700'
                : 'border-transparent text-neutral-700 hover:text-neutral-900'
            }`}
          >
            Overview
          </NavLink>
        </li>
        <li>
          <NavLink
            to={`/jobs/${jobId}/candidates`}
            aria-current={activeTab === 'candidates' ? 'page' : undefined}
            className={`${base} ${
              activeTab === 'candidates'
                ? 'border-primary-700 text-primary-700'
                : 'border-transparent text-neutral-700 hover:text-neutral-900'
            }`}
          >
            Candidates
          </NavLink>
        </li>
        <li>
          <NavLink
            to={`/jobs/${jobId}/pipeline`}
            aria-current={activeTab === 'pipeline' ? 'page' : undefined}
            className={`${base} ${
              activeTab === 'pipeline'
                ? 'border-primary-700 text-primary-700'
                : 'border-transparent text-neutral-700 hover:text-neutral-900'
            }`}
          >
            Pipeline
          </NavLink>
        </li>
        <li>
          {/* RC-08. Its own tab rather than a control inside RC-05: the
              weighting belongs to the job, not to one candidate list. */}
          <NavLink
            to={`/jobs/${jobId}/ranking-weights`}
            aria-current={activeTab === 'weights' ? 'page' : undefined}
            className={`${base} ${
              activeTab === 'weights'
                ? 'border-primary-700 text-primary-700'
                : 'border-transparent text-neutral-700 hover:text-neutral-900'
            }`}
          >
            Ranking weights
          </NavLink>
        </li>
        <li>
          <span aria-disabled="true" className={`${base} border-transparent text-neutral-300`}>
            Settings <span className="text-xs uppercase">Later</span>
          </span>
        </li>
      </ul>
    </nav>
  );
}
