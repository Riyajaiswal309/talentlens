import { Link, useParams } from 'react-router-dom';
import { ErrorState } from '../../components/ErrorState';
import { JobHeader } from './JobHeader';
import { toSkills, useJob, type JobResponse } from './useJobs';

/**
 * RC-04 — Job detail (Table 5.1; `GET /v1/jobs/:id`).
 *
 * The hub for one requisition: header, tab bar and the job's own record.
 *
 * WHAT IS DELIBERATELY ABSENT. Table 5.1 lists Edit and Close as secondary
 * actions; both are the RC-03 form, which is out of the agreed scope, so no
 * button is offered for a screen that does not exist. The AI-scoring state is
 * shown read-only, which is what BR-04 requires of every surface except the
 * Administrator's.
 */
export function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const query = useJob(jobId);

  if (query.isError) {
    return (
      <div>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  return (
    <div>
      <JobHeader job={query.data} loading={query.isPending} activeTab="overview" />
      {query.data && <JobRecord job={query.data} />}
    </div>
  );
}

function JobRecord({ job }: { job: JobResponse }) {
  const skills = toSkills(job.requiredSkills);

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
        <h2 className="text-base font-semibold text-neutral-900">Details</h2>
        <dl className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Department" value={job.department} />
          <Field label="Location" value={job.location} />
          <Field label="Employment type" value={job.employmentType} />
          <Field label="Experience level" value={job.experienceLevel} />
          <Field label="Created" value={formatDate(job.createdAt)} />
          <Field
            label="Published"
            // Null is meaningful here: a draft has never been public.
            value={job.publishedAt ? formatDate(job.publishedAt) : null}
          />
          {job.closedAt && <Field label="Closed" value={formatDate(job.closedAt)} />}
        </dl>
      </section>

      <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
        <h2 className="text-base font-semibold text-neutral-900">Required skills</h2>
        {skills.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-1">
            {skills.map((skill) => (
              <li
                key={skill}
                className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700"
              >
                {skill}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-neutral-500">None recorded.</p>
        )}
      </section>

      <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
        <h2 className="text-base font-semibold text-neutral-900">Description</h2>
        {job.description ? (
          // `whitespace-pre-line` keeps the author's paragraphs; the column is
          // capped near 75 characters, which §8.1 sets for readable prose.
          <p className="mt-2 max-w-[70ch] whitespace-pre-line text-sm text-neutral-700">
            {job.description}
          </p>
        ) : (
          <p className="mt-2 text-sm text-neutral-500">None recorded.</p>
        )}
      </section>

      <div>
        <Link
          to={`/jobs/${job.id}/candidates`}
          className="inline-flex h-10 items-center rounded-md bg-primary-700 px-4 text-sm font-semibold text-neutral-0 hover:bg-primary-600"
        >
          View candidates
        </Link>
      </div>
    </div>
  );
}

/** Nullable columns say "Not recorded" rather than rendering an empty cell. */
function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className={`mt-0.5 text-sm ${value ? 'text-neutral-900' : 'text-neutral-500'}`}>
        {value ?? 'Not recorded'}
      </dd>
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
