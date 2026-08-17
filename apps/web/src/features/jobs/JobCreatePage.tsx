import { useNavigate } from 'react-router-dom';
import { EMPTY_JOB_FORM, JobForm, toJobInput } from './JobForm';
import { useCreateJob } from './useJobMutations';

/**
 * RC-03 (create) — `POST /v1/jobs`.
 *
 * THE JOB IS SAVED AS A DRAFT, ALWAYS. `CreateJobDto` accepts no status, so
 * there is no "create and publish" call to make. That matches Phase 1 Flow 1,
 * which saves at step 5 and publishes at step 6 behind a confirmation — so the
 * button says "Save draft" and publishing happens on RC-04, where the job now
 * exists and the confirmation can name what it is about to make public.
 */
export function JobCreatePage() {
  const navigate = useNavigate();
  const create = useCreateJob();

  return (
    <div>
      <header className="mb-6">
        <p className="font-mono text-xs text-neutral-500">RC-03</p>
        <h1 className="text-2xl font-semibold text-neutral-900">Create job</h1>
        <p className="mt-1 text-sm text-neutral-700">
          Saved as a draft. You can publish it from the job page once it looks right.
        </p>
      </header>

      <JobForm
        initialValues={EMPTY_JOB_FORM}
        submitLabel="Save draft"
        pending={create.isPending}
        error={create.error}
        onCancel={() => navigate('/jobs')}
        onSubmit={(values) => {
          create.mutate(toJobInput(values), {
            // Navigate only after the API confirms, and go to the new job's own
            // page: Flow 1 step 8 ends on RC-04, and the id only exists now.
            onSuccess: (job) => navigate(`/jobs/${job.id}`, { replace: true }),
          });
        }}
      />
    </div>
  );
}
