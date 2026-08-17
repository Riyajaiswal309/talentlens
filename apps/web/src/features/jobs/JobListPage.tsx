import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, SkeletonTable } from '../../components/Skeleton';
import { AiScoringBadge, JobStatusBadge } from './JobStatusBadge';
import {
  JOB_STATUSES,
  toSkills,
  useDebouncedValue,
  useJobs,
  useJobsPagination,
  type JobResponse,
  type JobStatus,
} from './useJobs';

/**
 * RC-02 — Job list (Phase 1 Table 5.1; FR1.1; `GET /v1/jobs`).
 *
 * WHAT IS DELIBERATELY ABSENT. Table 5.1 also lists an applicant count per
 * row, and there is no field for it: `JobResponse` carries no count and no
 * endpoint returns one. Rendering a zero, or counting a candidates request per
 * row, would both put a number on screen that the API never stated — so the
 * column is left out and named here instead.
 *
 * The Create, Duplicate and Close actions belong to RC-03 and are out of the
 * agreed scope; no button is shown for a screen that does not exist.
 */
export function JobListPage() {
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [departmentInput, setDepartmentInput] = useState('');

  // Debounced so a typed department is one request, not one per keystroke.
  const department = useDebouncedValue(departmentInput.trim(), 300);

  const filters = {
    ...(status ? { status } : {}),
    ...(department ? { department } : {}),
  };
  const filtersActive = Boolean(status || department);

  const { cursor, pageNumber, canGoBack, goNext, goBack } = useJobsPagination(filters);
  const query = useJobs(filters, cursor);

  const statusId = useId();
  const departmentId = useId();

  function clearFilters() {
    setStatus('');
    setDepartmentInput('');
  }

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-neutral-500">RC-02</p>
          <h1 className="text-2xl font-semibold text-neutral-900">Jobs</h1>
          <p className="mt-1 text-sm text-neutral-700">
            Requisitions in your company. Open one to see its candidates.
          </p>
        </div>
        {/* RC-02's primary action alongside "Open job" (Table 5.1). */}
        <Link
          to="/jobs/new"
          className="inline-flex h-10 items-center rounded-md bg-primary-700 px-4 text-sm font-semibold text-neutral-0 hover:bg-primary-600"
        >
          Create job
        </Link>
      </header>

      <div className="mb-4 flex flex-wrap items-end gap-4 rounded-md border border-neutral-300 bg-neutral-0 p-4">
        <div>
          <label htmlFor={statusId} className="mb-1 block text-sm font-semibold text-neutral-900">
            Status
          </label>
          {/*
            Exactly the three values of `enum JobStatus`. `ListJobsQueryDto`
            validates with @IsEnum, so any other option would be a guaranteed
            400 — the filter cannot offer more than the API accepts.
          */}
          <select
            id={statusId}
            value={status}
            onChange={(event) => setStatus(event.target.value as JobStatus | '')}
            className="h-10 rounded-sm border border-neutral-300 bg-neutral-0 px-3 text-sm text-neutral-900"
          >
            <option value="">All statuses</option>
            {JOB_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value[0]! + value.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor={departmentId}
            className="mb-1 block text-sm font-semibold text-neutral-900"
          >
            Department
          </label>
          {/* Free text: `jobs.department` is a nullable string and nothing
              enumerates the values in use, so there are no options to offer. */}
          <input
            id={departmentId}
            type="text"
            value={departmentInput}
            onChange={(event) => setDepartmentInput(event.target.value)}
            placeholder="e.g. Engineering"
            className="h-10 w-56 rounded-sm border border-neutral-300 px-3 text-sm text-neutral-900"
          />
        </div>

        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100"
          >
            Clear filters
          </button>
        )}
      </div>

      <JobListBody
        query={query}
        filtersActive={filtersActive}
        onClearFilters={clearFilters}
        pageNumber={pageNumber}
        canGoBack={canGoBack}
        onNext={goNext}
        onBack={goBack}
      />
    </div>
  );
}

function JobListBody({
  query,
  filtersActive,
  onClearFilters,
  pageNumber,
  canGoBack,
  onNext,
  onBack,
}: {
  query: ReturnType<typeof useJobs>;
  filtersActive: boolean;
  onClearFilters: () => void;
  pageNumber: number;
  canGoBack: boolean;
  onNext: (cursor: string) => void;
  onBack: () => void;
}) {
  // FIRST LOAD ONLY. `isPending` is true when there is nothing cached to show;
  // a later page keeps the previous rows visible and dims them instead.
  if (query.isPending) {
    return (
      <LoadingState label="Loading jobs…">
        <SkeletonTable rows={5} columns={4} />
      </LoadingState>
    );
  }

  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const jobs = query.data?.data ?? [];
  const nextCursor = query.data?.nextCursor ?? null;

  if (jobs.length === 0) {
    /*
     * TWO DIFFERENT EMPTIES (Table 5.1). A filter that matched nothing needs
     * the filter cleared; an account with no jobs at all needs a job created.
     * Offering the wrong one sends the user somewhere that cannot help.
     */
    return filtersActive ? (
      <EmptyState
        variant="filtered"
        title="No jobs match these filters"
        description="No requisition in your company matches the status or department you selected."
        action={
          <button
            type="button"
            onClick={onClearFilters}
            className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100"
          >
            Clear filters
          </button>
        }
      />
    ) : (
      <EmptyState
        title="No jobs yet"
        description="Requisitions your company creates will appear here."
        // Flow 1: "First-time RC-02 shows an empty state with a single Create
        // job CTA." One action, because there is nothing else to do here.
        action={
          <Link
            to="/jobs/new"
            className="inline-flex h-10 items-center rounded-md bg-primary-700 px-4 text-sm font-semibold text-neutral-0 hover:bg-primary-600"
          >
            Create job
          </Link>
        }
      />
    );
  }

  return (
    <>
      {/*
        Paging keeps the old rows on screen; aria-busy plus the dimming says
        "these are being replaced" without the layout collapsing.
      */}
      <div aria-busy={query.isFetching} className={query.isFetching ? 'opacity-60' : undefined}>
        <ul className="divide-y divide-neutral-300 overflow-hidden rounded-md border border-neutral-300 bg-neutral-0">
          {jobs.map((job) => (
            <li key={job.id}>
              <JobRow job={job} />
            </li>
          ))}
        </ul>
      </div>

      <nav
        aria-label="Pagination"
        className="mt-4 flex items-center justify-between text-sm text-neutral-700"
      >
        <span>
          Page {pageNumber}
          {/* No total: a cursor API never counts the full set, and inventing
              "of N" would be a number the server never gave. */}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onBack}
            disabled={!canGoBack}
            aria-disabled={!canGoBack}
            className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => nextCursor && onNext(nextCursor)}
            disabled={!nextCursor}
            aria-disabled={!nextCursor}
            className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </nav>
    </>
  );
}

function JobRow({ job }: { job: JobResponse }) {
  const skills = toSkills(job.requiredSkills);

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 hover:bg-neutral-100">
      <div className="min-w-0">
        {/* The link is the title — "Open job" is RC-02's primary action. */}
        <Link
          to={`/jobs/${job.id}`}
          className="rounded-sm text-base font-semibold text-primary-700 hover:underline"
        >
          {job.title}
        </Link>

        <p className="mt-1 text-sm text-neutral-700">
          {/* Every one of these is nullable in JobResponse; only what the API
              actually returned is shown, joined without empty separators. */}
          {[job.department, job.location, job.employmentType, job.experienceLevel]
            .filter(Boolean)
            .join(' · ') || 'No further details recorded'}
        </p>

        {skills.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1">
            {skills.map((skill) => (
              <li
                key={skill}
                className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700"
              >
                {skill}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        <div className="flex gap-2">
          <JobStatusBadge status={job.status} />
          <AiScoringBadge enabled={job.aiScoringEnabled} />
        </div>
        <p className="text-xs text-neutral-500">
          {job.publishedAt
            ? `Published ${formatDate(job.publishedAt)}`
            : `Created ${formatDate(job.createdAt)}`}
        </p>
      </div>
    </div>
  );
}

/** ISO timestamps are for machines; the row shows a readable date. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
