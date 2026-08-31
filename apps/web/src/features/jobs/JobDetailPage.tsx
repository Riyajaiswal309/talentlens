import { Link, useNavigate, useParams } from 'react-router-dom';
import { ErrorState } from '../../components/ErrorState';
import { ArrowRightIcon, UsersIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Card, CardHeader, Chip, Field, buttonClass } from '../../components/ui';
import { isUuidV4, useFunnel } from '../analytics/useFunnel';
import { JobHeader } from './JobHeader';
import { toSkills, useJob, type JobResponse, type JobStatus } from './useJobs';
import { ALLOWED_STATUS_TRANSITIONS, useDuplicateJob, useUpdateJob } from './useJobMutations';
import { useAuth } from '../../auth/AuthContext';
import { useSetAiScoring } from '../admin/useAdmin';

/**
 * RC-04 — Job detail (Table 5.1; `GET /v1/jobs/:id`).
 *
 * The hub for one requisition: header, tab bar and the job's own record.
 *
 * THE CANDIDATE COUNTS COME FROM THE FUNNEL, not from a count endpoint — none
 * exists. `GET /v1/analytics/funnel?jobId=` returns this job's
 * `totalApplications` and per-stage `currentlyHere` in ONE request, which is
 * the same source RC-09's board columns use, so the two cannot disagree. The
 * strip is omitted entirely for an id the funnel will not accept (see
 * `isUuidV4`) rather than showing zeros.
 */
export function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const query = useJob(jobId);

  if (query.isError) {
    return (
      <div>
        {/* The whole page: `JobHeader` renders nothing when the job errored,
            so this panel carries the document's only heading. */}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} as="h1" />
      </div>
    );
  }

  return (
    <div>
      <JobHeader
        job={query.data}
        loading={query.isPending}
        activeTab="overview"
        errored={query.isError}
      />
      {query.data && <JobStats job={query.data} />}
      {query.data && <JobActions job={query.data} />}
      {query.data && <JobRecord job={query.data} />}
    </div>
  );
}

/**
 * This requisition's pipeline at a glance.
 *
 * Rendered only when the funnel can actually answer for this job: its filter is
 * `@IsUUID('4')`, so a non-v4 id would 400. Silence beats a zero.
 */
function JobStats({ job }: { job: JobResponse }) {
  const eligible = isUuidV4(job.id);
  const funnel = useFunnel(eligible ? { jobId: job.id } : {});

  if (!eligible || funnel.isError || !funnel.data) return null;

  const report = funnel.data;

  return (
    <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card className="p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Applications
        </p>
        <p className="mt-1.5 text-2xl font-semibold tabular-nums text-neutral-900">
          {report.totalApplications}
        </p>
      </Card>

      {/* The three non-terminal stages a recruiter watches most. */}
      {report.stages
        .filter((stage) => !stage.isTerminal)
        .slice(1, 4)
        .map((stage) => (
          <Card key={stage.name} className="p-4">
            <p className="truncate text-xs font-semibold uppercase tracking-wide text-neutral-500">
              In {stage.name.toLowerCase()}
            </p>
            <p className="mt-1.5 text-2xl font-semibold tabular-nums text-neutral-900">
              {stage.currentlyHere}
            </p>
          </Card>
        ))}
    </div>
  );
}

/**
 * Table 5.1's RC-04 secondary actions — Edit and Close, plus Publish.
 *
 * ONLY WHAT THE API WILL ACCEPT IS SHOWN. `ALLOWED_TRANSITIONS` permits
 * DRAFT → PUBLISHED|CLOSED and PUBLISHED → CLOSED, and refuses everything else
 * with a 409; a closed job cannot be modified at all, so it gets no controls.
 * Rendering a Publish button on a closed job would be a guaranteed error
 * dressed up as an action.
 */
function JobActions({ job }: { job: JobResponse }) {
  const update = useUpdateJob(job.id);
  const duplicate = useDuplicateJob(job.id);
  const navigate = useNavigate();
  const { notify } = useToast();
  const allowed = ALLOWED_STATUS_TRANSITIONS[job.status as JobStatus] ?? [];
  const closed = job.status === 'CLOSED';

  /*
   * FR1.3 — duplicating is allowed on ANY job, including a closed one: the
   * point of a template is to reopen a role that ended. So it sits outside the
   * `closed` early return below, unlike Edit and Publish which the API refuses.
   */
  function onDuplicate() {
    if (!window.confirm(`Duplicate “${job.title}” as a new draft?`)) return;
    duplicate.mutate(undefined, {
      onSuccess: (copy) => {
        notify(`“${job.title}” duplicated as a draft.`);
        // The user's next act is always to edit the copy.
        navigate(`/jobs/${copy.id}/edit`);
      },
    });
  }

  function change(target: JobStatus) {
    const message =
      target === 'PUBLISHED'
        ? 'Publish this job? It becomes publicly visible on the careers page.'
        : 'Close this job? A closed job cannot be edited or reopened.';
    // Table 5.1 requires a publish confirmation; closing is irreversible, which
    // §8.6 reserves the danger variant and a confirmed step for.
    if (!window.confirm(message)) return;
    /*
     * These two are the reason the toast exists: on success the only thing that
     * changes is a badge, which is easy to miss after an irreversible action.
     * The confirmation is raised only once the SERVER has answered — never
     * optimistically, or it would claim a publish that failed.
     */
    update.mutate(
      { status: target },
      {
        onSuccess: () =>
          notify(
            target === 'PUBLISHED'
              ? `“${job.title}” is now published.`
              : `“${job.title}” is now closed.`,
          ),
      },
    );
  }

  const duplicateButton = (
    <button
      type="button"
      onClick={onDuplicate}
      disabled={duplicate.isPending}
      aria-disabled={duplicate.isPending}
      className={buttonClass('secondary')}
    >
      {duplicate.isPending ? 'Duplicating…' : 'Duplicate'}
    </button>
  );

  if (closed) {
    return (
      <div className="mb-5">
        <p className="mb-3 text-sm text-neutral-500">
          Closed jobs are read-only — they cannot be edited or reopened.
        </p>
        {/* Still offered: a closed role is exactly what one duplicates. */}
        {duplicateButton}
        <AdminAiScoringToggle job={job} />
        {duplicate.error != null && (
          <div className="mt-3">
            <ErrorState error={duplicate.error} title="The job was not duplicated" />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/jobs/${job.id}/edit`} className={buttonClass('secondary')}>
          Edit
        </Link>

        {duplicateButton}

        {allowed.includes('PUBLISHED') && (
          <button
            type="button"
            onClick={() => change('PUBLISHED')}
            disabled={update.isPending}
            aria-disabled={update.isPending}
            className={buttonClass('primary')}
          >
            {update.isPending ? 'Working…' : 'Publish'}
          </button>
        )}

        {allowed.includes('CLOSED') && (
          <button
            type="button"
            onClick={() => change('CLOSED')}
            disabled={update.isPending}
            aria-disabled={update.isPending}
            className={buttonClass('danger')}
          >
            Close job
          </button>
        )}
      </div>

      <AdminAiScoringToggle job={job} />

      {(update.error != null || duplicate.error != null) && (
        <div className="mt-3">
          <ErrorState
            error={update.error ?? duplicate.error}
            title="That change could not be applied"
          />
        </div>
      )}
    </div>
  );
}

/**
 * FR1.4 / FR8.2 / BR-04 — the per-job AI scoring toggle, Administrator only.
 *
 * BR-04 names `PATCH /v1/admin/jobs/:id/ai-scoring` as the enforcement point
 * and the route is `@Roles(ADMIN)`. Rendering nothing for a Recruiter is not
 * cosmetic: every other surface shows this flag READ-ONLY, and only an
 * Administrator may change it.
 */
function AdminAiScoringToggle({ job }: { job: JobResponse }) {
  const { user } = useAuth();
  const setAiScoring = useSetAiScoring(job.id);
  const { notify } = useToast();

  if (user?.role !== 'ADMIN') return null;

  function onToggle() {
    const next = !job.aiScoringEnabled;
    const message = next
      ? 'Enable AI scoring for this job? Candidates will be ranked once a model runs.'
      : 'Disable AI scoring for this job? Candidates will be listed newest first with no score.';
    if (!window.confirm(message)) return;
    setAiScoring.mutate(next, {
      onSuccess: (result) =>
        notify(
          `AI scoring ${result.aiScoringEnabled ? 'enabled' : 'disabled'} for “${job.title}”.`,
        ),
    });
  }

  return (
    <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-4">
      <p className="text-sm font-semibold text-neutral-900">
        AI scoring is {job.aiScoringEnabled ? 'on' : 'off'} for this job
      </p>
      <p className="mt-1 max-w-[68ch] text-xs leading-relaxed text-neutral-500">
        Only an Administrator can change this (BR-04). No model is trained in this build, so
        enabling it does not produce scores — it changes how the candidate list is presented once
        one does.
      </p>
      <button
        type="button"
        onClick={onToggle}
        disabled={setAiScoring.isPending}
        aria-disabled={setAiScoring.isPending}
        className={`${buttonClass('secondary', 'sm')} mt-3`}
      >
        {setAiScoring.isPending
          ? 'Saving…'
          : job.aiScoringEnabled
            ? 'Disable AI scoring'
            : 'Enable AI scoring'}
      </button>
      {setAiScoring.error != null && (
        <div className="mt-3">
          <ErrorState error={setAiScoring.error} title="The setting was not changed" />
        </div>
      )}
    </div>
  );
}

function JobRecord({ job }: { job: JobResponse }) {
  const skills = toSkills(job.requiredSkills);

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader title="Description" />
          <div className="p-5">
            {job.description ? (
              // `whitespace-pre-line` keeps the author's paragraphs; the column is
              // capped near 75 characters, which §8.1 sets for readable prose.
              <p className="max-w-[70ch] whitespace-pre-line text-sm leading-relaxed text-neutral-700">
                {job.description}
              </p>
            ) : (
              <p className="text-sm text-neutral-400">None recorded.</p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Required skills" />
          <div className="p-5">
            {skills.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {skills.map((skill) => (
                  <li key={skill}>
                    <Chip>{skill}</Chip>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-neutral-400">None recorded.</p>
            )}
          </div>
        </Card>
      </div>

      <div className="space-y-5">
        <Card>
          <CardHeader title="Details" />
          <dl className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-1">
            <Field label="Department" value={job.department} />
            <Field label="Location" value={job.location} />
            <Field label="Employment type" value={job.employmentType} />
            <Field label="Experience level" value={job.experienceLevel} />
            <Field label="Created" value={formatDate(job.createdAt)} />
            {/* Null is meaningful here: a draft has never been public. */}
            <Field label="Published" value={job.publishedAt ? formatDate(job.publishedAt) : null} />
            {job.closedAt && <Field label="Closed" value={formatDate(job.closedAt)} />}
          </dl>
        </Card>

        <Link
          to={`/jobs/${job.id}/candidates`}
          className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-0 p-5 shadow-card transition-shadow hover:shadow-card-hover"
        >
          <span className="flex items-center gap-3">
            <span className="rounded-md bg-primary-50 p-2 text-primary-700">
              <UsersIcon />
            </span>
            <span>
              <span className="block text-sm font-semibold text-neutral-900">View candidates</span>
              <span className="block text-xs text-neutral-500">
                Everyone who applied to this role
              </span>
            </span>
          </span>
          <ArrowRightIcon className="h-4 w-4 shrink-0 text-neutral-400" />
        </Link>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
