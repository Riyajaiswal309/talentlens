import { useId, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, SkeletonText } from '../../components/Skeleton';
import { useBreadcrumbLabel } from '../../layouts/Breadcrumbs';
import { JobForm, toJobInput, type JobFormValues } from './JobForm';
import { toSkills, useJob, type JobStatus } from './useJobs';
import { ALLOWED_STATUS_TRANSITIONS, useUpdateJob } from './useJobMutations';

/**
 * RC-03 (edit) — `PATCH /v1/jobs/:id`.
 *
 * A CLOSED JOB IS NOT EDITABLE AT ALL. `jobs.service.update` throws 409 for one
 * before it looks at any field, which is Table 5.1's "closed-job read-only
 * state" enforced server-side. The form is therefore not rendered for a closed
 * job — showing it would invite a recruiter to type changes that cannot save.
 */
export function JobEditPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const query = useJob(jobId);
  const update = useUpdateJob(jobId);

  useBreadcrumbLabel(query.data?.id, query.data?.title);

  if (query.isPending) {
    return (
      <LoadingState label="Loading job…">
        <SkeletonText lines={6} />
      </LoadingState>
    );
  }

  if (query.isError) {
    // The whole page — no header renders above it, so this carries the h1.
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} as="h1" />;
  }

  const job = query.data;
  if (!job) return null;

  if (job.status === 'CLOSED') {
    return (
      <div>
        <header className="mb-6">
          <p className="font-mono text-xs text-neutral-500">RC-03</p>
          <h1 className="text-2xl font-semibold text-neutral-900">{job.title}</h1>
        </header>
        <div className="rounded-lg border border-neutral-200 bg-neutral-0 shadow-card px-6 py-8 text-center">
          <h2 className="text-base font-semibold text-neutral-900">This job is closed</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-neutral-700">
            A closed job cannot be edited or reopened. Create a new job if the role opens again.
          </p>
          <button
            type="button"
            onClick={() => navigate(`/jobs/${job.id}`)}
            className="mt-6 h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-100"
          >
            Back to the job
          </button>
        </div>
      </div>
    );
  }

  const initialValues: JobFormValues = {
    title: job.title,
    // Nullable columns become empty strings for the inputs; `toJobInput` turns
    // an untouched empty field back into `undefined` so PATCH omits the key.
    department: job.department ?? '',
    location: job.location ?? '',
    employmentType: job.employmentType ?? '',
    experienceLevel: job.experienceLevel ?? '',
    description: job.description ?? '',
    requiredSkills: toSkills(job.requiredSkills),
  };

  return (
    <div>
      <header className="mb-6">
        <p className="font-mono text-xs text-neutral-500">RC-03</p>
        <h1 className="text-2xl font-semibold text-neutral-900">Edit job</h1>
        <p className="mt-1 text-sm text-neutral-700">{job.title}</p>
      </header>

      <JobForm
        initialValues={initialValues}
        submitLabel="Save changes"
        pending={update.isPending}
        error={update.error}
        onCancel={() => navigate(`/jobs/${job.id}`)}
        onSubmit={(values) => {
          update.mutate(toJobInput(values), {
            onSuccess: () => navigate(`/jobs/${job.id}`),
          });
        }}
        extraSection={<StatusSection current={job.status} jobId={job.id} />}
      />
    </div>
  );
}

/**
 * The status control, offering only transitions the API will accept.
 *
 * SEPARATE FROM THE FORM'S SAVE, deliberately. A status change is not a field
 * edit: publishing makes the job publicly visible and closing is irreversible,
 * so each is its own confirmed action rather than something that rides along
 * with a corrected job title. It is also why this posts its own PATCH.
 */
function StatusSection({ current, jobId }: { current: string; jobId: string }) {
  const navigate = useNavigate();
  const update = useUpdateJob(jobId);
  const selectId = useId();
  const [target, setTarget] = useState<JobStatus | ''>('');

  const allowed = ALLOWED_STATUS_TRANSITIONS[current as JobStatus] ?? [];

  function apply() {
    if (!target) return;

    /*
     * Table 5.1 requires a publish confirmation, and §8.6 reserves a confirmed
     * step for destructive actions — closing is irreversible here because
     * CLOSED has no outgoing transitions.
     */
    const message =
      target === 'PUBLISHED'
        ? 'Publish this job? It becomes publicly visible on the careers page.'
        : 'Close this job? A closed job cannot be edited or reopened.';
    if (!window.confirm(message)) return;

    update.mutate({ status: target }, { onSuccess: () => navigate(`/jobs/${jobId}`) });
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-neutral-0 shadow-card p-4">
      <h2 className="text-base font-semibold text-neutral-900">Status</h2>
      <p className="mt-1 text-sm text-neutral-700">
        Currently <span className="font-semibold">{label(current)}</span>.
      </p>

      {allowed.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">No further status change is possible.</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={selectId} className="mb-1 block text-sm font-semibold text-neutral-900">
              Change status to
            </label>
            {/*
              Only the legal targets. `ALLOWED_TRANSITIONS` refuses everything
              else with a 409, so listing DRAFT here for a published job would
              be a control whose only outcome is an error.
            */}
            <select
              id={selectId}
              value={target}
              onChange={(event) => setTarget(event.target.value as JobStatus | '')}
              className="h-10 rounded-sm border border-neutral-300 bg-neutral-0 px-3 text-sm text-neutral-900"
            >
              <option value="">No change</option>
              {allowed.map((status) => (
                <option key={status} value={status}>
                  {label(status)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={apply}
            disabled={!target || update.isPending}
            aria-disabled={!target || update.isPending}
            className={`h-10 rounded-md px-4 text-sm font-semibold disabled:opacity-40 ${
              target === 'CLOSED'
                ? 'bg-danger-700 text-neutral-0 hover:opacity-90'
                : 'border border-neutral-300 bg-neutral-0 text-neutral-900 hover:bg-neutral-100'
            }`}
          >
            {update.isPending ? 'Applying…' : 'Apply status'}
          </button>
        </div>
      )}

      {update.error != null && (
        <div className="mt-3">
          <ErrorState error={update.error} title="The status could not be changed" />
        </div>
      )}
    </section>
  );
}

function label(status: string): string {
  if (!status) return '';
  return status[0]! + status.slice(1).toLowerCase();
}
