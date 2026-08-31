import { NavLink } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useBreadcrumbLabel } from '../../layouts/Breadcrumbs';
import { Skeleton } from '../../components/Skeleton';
import { Notice } from '../../components/ui';
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
  errored = false,
}: {
  job: JobResponse | undefined;
  loading: boolean;
  activeTab: JobTab;
  /**
   * The job could not be read at all — a 404, or another tenant's id.
   *
   * REQUIRED, BECAUSE "NO JOB" IS AMBIGUOUS. `job === undefined` means either
   * "still arriving" or "will never arrive", and treating both as loading left
   * a skeleton pulsing forever above the page's own error panel. The caller
   * knows which it is, so it says.
   */
  errored?: boolean;
}) {
  // Before any early return: hooks must run on every render.
  useBreadcrumbLabel(job?.id, job?.title);

  /*
   * Nothing at all when the job is gone. The page below already renders the
   * refusal, and a header with no title — or worse, a skeleton implying one is
   * on its way — would only compete with it.
   */
  if (errored) return null;

  if (loading || !job) {
    return (
      <header className="mb-6">
        <Skeleton className="h-[14px] w-16" />
        <Skeleton className="mt-2 h-[32px] w-72" />
        <Skeleton className="mt-3 h-[14px] w-96" />
      </header>
    );
  }

  const closed = job.status === 'CLOSED';

  return (
    <header className="mb-6">
      <p className="font-mono text-2xs uppercase tracking-widest text-neutral-400">RC-04</p>
      <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold text-neutral-900 sm:text-[1.75rem]">{job.title}</h1>
        <div className="flex gap-2">
          <JobStatusBadge status={job.status} />
          <AiScoringBadge enabled={job.aiScoringEnabled} />
        </div>
      </div>

      <p className="mt-1.5 text-sm text-neutral-500">
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
        <div className="mt-4">
          <Notice tone="neutral">This job is closed. It is shown read-only.</Notice>
        </div>
      )}

      <JobTabs jobId={job.id} activeTab={activeTab} />
    </header>
  );
}

/** One tab. Extracted so the five entries cannot drift apart in styling. */
function Tab({
  to,
  active,
  end = false,
  children,
}: {
  to: string;
  active: boolean;
  end?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li>
      <NavLink
        to={to}
        end={end}
        aria-current={active ? 'page' : undefined}
        className={`-mb-px inline-block border-b-2 px-1 pb-3 text-sm font-semibold transition-colors duration-150 ${
          active
            ? 'border-primary-700 text-primary-700'
            : 'border-transparent text-neutral-500 hover:border-neutral-300 hover:text-neutral-900'
        }`}
      >
        {children}
      </NavLink>
    </li>
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
  /*
   * A Hiring Manager sees Candidates only.
   *
   * Overview (RC-03) reads `GET /v1/analytics/funnel`, Pipeline is stage
   * mechanics and Ranking weights is `PUT …/ranking-weights` — all Recruiter
   * and Admin. §24.2 keeps this persona on assessment, so the tabs are omitted
   * rather than rendered disabled: disabled implies "not yet", and these are
   * never coming for this role.
   */
  const { user } = useAuth();
  const reviewerOnly = user?.role === 'HIRING_MANAGER';

  return (
    <nav aria-label="Job sections" className="mt-6 border-b border-neutral-200">
      <ul className="flex gap-6 overflow-x-auto">
        {!reviewerOnly && (
          <Tab to={`/jobs/${jobId}`} end active={activeTab === 'overview'}>
            Overview
          </Tab>
        )}
        <Tab to={`/jobs/${jobId}/candidates`} active={activeTab === 'candidates'}>
          Candidates
        </Tab>
        {!reviewerOnly && (
          <Tab to={`/jobs/${jobId}/pipeline`} active={activeTab === 'pipeline'}>
            Pipeline
          </Tab>
        )}
        {/* RC-08. Its own tab rather than a control inside RC-05: the
            weighting belongs to the job, not to one candidate list. */}
        {!reviewerOnly && (
          <Tab to={`/jobs/${jobId}/ranking-weights`} active={activeTab === 'weights'}>
            Ranking weights
          </Tab>
        )}
        <li>
          <span
            aria-disabled="true"
            className="-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-1 pb-3 text-sm font-semibold text-neutral-300"
          >
            Settings
            <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-neutral-400">
              Later
            </span>
          </span>
        </li>
      </ul>
    </nav>
  );
}
