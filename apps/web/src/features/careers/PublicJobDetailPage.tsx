import { Link, useParams } from 'react-router-dom';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, Skeleton, SkeletonText } from '../../components/Skeleton';
import { ArrowRightIcon } from '../../components/icons';
import { Card, CardHeader, Chip, Field, Notice, buttonClass } from '../../components/ui';
import { CareersLayout } from './CareersLayout';
import { formatDate, toSkillList, usePublicJob } from './usePublicJobs';

/**
 * FR2.1 — one open role, publicly readable, with the Apply action.
 *
 * THE APPLY BUTTON IS CONDITIONAL. `POST /v1/applications` validates `jobId`
 * with `@IsUUID('4')`, so a job whose id is not a v4 uuid cannot receive an
 * application no matter what the form does. Offering Apply there would send the
 * candidate to a form whose only possible outcome is a 400, so the page states
 * the situation instead. This is the same UUID inconsistency the recruiter
 * console works around in its analytics filter.
 */
export function PublicJobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const query = usePublicJob(jobId);

  if (query.isPending) {
    return (
      <CareersLayout>
        <LoadingState label="Loading this role…">
          <Skeleton className="h-[36px] w-96" />
          <div className="mt-4">
            <SkeletonText lines={6} />
          </div>
        </LoadingState>
      </CareersLayout>
    );
  }

  if (query.isError) {
    // A 404 covers "no such role" and "not published" alike — the public
    // endpoint does not distinguish, and neither does this wording.
    return (
      <CareersLayout>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} as="h1" />
        <p className="mt-6">
          <Link to="/careers" className="text-sm font-semibold text-primary-700 hover:underline">
            ← Back to open roles
          </Link>
        </p>
      </CareersLayout>
    );
  }

  const job = query.data;
  if (!job) return null;

  const skills = toSkillList(job.requiredSkills);
  const applyable = isUuidV4(job.id);

  return (
    <CareersLayout>
      <p className="mb-4">
        <Link to="/careers" className="text-sm font-semibold text-primary-700 hover:underline">
          ← Back to open roles
        </Link>
      </p>

      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">{job.title}</h1>
        <p className="mt-2 text-base text-neutral-500">
          {[job.department, job.location, job.employmentType, job.experienceLevel]
            .filter(Boolean)
            .join(' · ') || 'No further details listed'}
        </p>

        <div className="mt-6">
          {applyable ? (
            <Link to={`/careers/${job.id}/apply`} className={buttonClass('primary')}>
              Apply for this role
              <ArrowRightIcon />
            </Link>
          ) : (
            <Notice tone="warning" title="Applications cannot be accepted for this role online">
              This posting predates the current application format, so the form cannot submit
              against it. Please contact the hiring team directly.
            </Notice>
          )}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="About this role" />
            <div className="p-5 sm:p-6">
              {job.description ? (
                <p className="max-w-[70ch] whitespace-pre-line text-sm leading-relaxed text-neutral-700">
                  {job.description}
                </p>
              ) : (
                <p className="text-sm text-neutral-400">No description was provided.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="What we're looking for" />
            <div className="p-5 sm:p-6">
              {skills.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {skills.map((skill) => (
                    <li key={skill}>
                      <Chip>{skill}</Chip>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-neutral-400">No specific skills were listed.</p>
              )}
            </div>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader title="Role details" />
          <dl className="grid gap-4 p-5 sm:p-6">
            <Field label="Department" value={job.department} />
            <Field label="Location" value={job.location} />
            <Field label="Employment type" value={job.employmentType} />
            <Field label="Experience level" value={job.experienceLevel} />
            <Field label="Posted" value={job.publishedAt ? formatDate(job.publishedAt) : null} />
          </dl>
        </Card>
      </div>
    </CareersLayout>
  );
}

/**
 * Will `POST /v1/applications` accept this job id?
 *
 * `SubmitApplicationDto` validates `jobId` with `@IsUUID('4')`, which requires
 * the version nibble to be 4 and the variant nibble 8/9/a/b.
 */
function isUuidV4(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}
