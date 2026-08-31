import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, SkeletonTable } from '../../components/Skeleton';
import { ArrowRightIcon } from '../../components/icons';
import { Card, Chip, buttonClass } from '../../components/ui';
import { CareersLayout } from './CareersLayout';
import { formatDate, toSkillList, usePublicJobs, type PublicJob } from './usePublicJobs';

/**
 * FR2.1 — the public list of open roles.
 *
 * PUBLISHED ONLY, and the server decides that. `listPublic` filters by status,
 * so everything returned here is genuinely open; the page does not re-filter.
 *
 * Cursor pagination with no total (§23.1), so there is no "N roles" heading —
 * the endpoint never counts the set.
 */
export function PublicJobsPage() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const query = usePublicJobs(cursor);

  return (
    <CareersLayout>
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">Open roles</h1>
        <p className="mt-2 max-w-2xl text-base text-neutral-700">
          Every role currently accepting applications. Choose one to read the description and apply
          — no account needed.
        </p>
      </header>

      {query.isPending ? (
        <LoadingState label="Loading open roles…">
          <SkeletonTable rows={4} columns={3} />
        </LoadingState>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (query.data?.data.length ?? 0) === 0 ? (
        <EmptyState
          title="No open roles right now"
          description="There are no published roles at the moment. Please check back later."
        />
      ) : (
        <>
          <ul className="space-y-4">
            {query.data!.data.map((job) => (
              <li key={job.id}>
                <JobCard job={job} />
              </li>
            ))}
          </ul>

          <nav
            aria-label="Pagination"
            className="mt-8 flex items-center justify-between text-sm text-neutral-500"
          >
            <button
              type="button"
              onClick={() => setCursor(undefined)}
              disabled={cursor === undefined}
              aria-disabled={cursor === undefined}
              className={buttonClass('secondary')}
            >
              First page
            </button>
            <button
              type="button"
              onClick={() => query.data?.nextCursor && setCursor(query.data.nextCursor)}
              disabled={!query.data?.nextCursor}
              aria-disabled={!query.data?.nextCursor}
              className={buttonClass('secondary')}
            >
              More roles
            </button>
          </nav>
        </>
      )}
    </CareersLayout>
  );
}

function JobCard({ job }: { job: PublicJob }) {
  const skills = toSkillList(job.requiredSkills);

  return (
    <Card interactive className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-neutral-900">
            {/*
              The whole card is not a link: it contains its own Apply action, and
              nesting an anchor inside an anchor is invalid. The title is the
              link, which is also what a screen reader reads out of the list.
            */}
            <Link to={`/careers/${job.id}`} className="rounded-sm hover:text-primary-700">
              {job.title}
            </Link>
          </h2>

          <p className="mt-1 text-sm text-neutral-500">
            {[job.department, job.location, job.employmentType, job.experienceLevel]
              .filter(Boolean)
              .join(' · ') || 'No further details listed'}
          </p>

          {skills.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {skills.slice(0, 6).map((skill) => (
                <li key={skill}>
                  <Chip>{skill}</Chip>
                </li>
              ))}
            </ul>
          )}

          {job.publishedAt && (
            <p className="mt-3 text-xs text-neutral-400">Posted {formatDate(job.publishedAt)}</p>
          )}
        </div>

        <Link to={`/careers/${job.id}`} className={`${buttonClass('primary')} shrink-0`}>
          View role
          <ArrowRightIcon />
        </Link>
      </div>
    </Card>
  );
}
